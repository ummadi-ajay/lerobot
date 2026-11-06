#!/usr/bin/env python3
# Copyright 2026 Ajay Ummadi (MakerWorks Lab).
# Licensed under the Apache License, Version 2.0; see the LICENSE file at the root of this repository.
"""Local web app for SO101 leader/follower teleoperation.

Run:  python dashboard/server.py [--host 127.0.0.1] [--port 8765]
Open: http://127.0.0.1:8765

Only one process can own the serial ports, so stop any running lerobot-teleoperate first.
"""

import argparse
import csv
import glob
import json
import re
import socket
import threading
import time
from datetime import datetime
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from lerobot.robots.so_follower import SO100Follower, SO100FollowerConfig, SO101Follower, SO101FollowerConfig
from lerobot.teleoperators.so_leader import SO100Leader, SO100LeaderConfig, SO101Leader, SO101LeaderConfig
from lerobot.utils.constants import HF_LEROBOT_CALIBRATION, ROBOTS, TELEOPERATORS

HERE = Path(__file__).parent
STATIC = HERE / "static"
CONFIG_PATH = HERE / "config.json"
REC_DIR = HERE / "recordings"
ARMS = {
    "so101": (SO101Follower, SO101FollowerConfig, SO101Leader, SO101LeaderConfig),
    "so100": (SO100Follower, SO100FollowerConfig, SO100Leader, SO100LeaderConfig),
}
REC_NAME = re.compile(r"^teleop_\d{8}_\d{6}\.csv$")
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
CAL_DIRS = {
    "follower": HF_LEROBOT_CALIBRATION / ROBOTS / "so_follower",
    "leader": HF_LEROBOT_CALIBRATION / TELEOPERATORS / "so_leader",
}
DEFAULT_CONFIG = {
    "robot_type": "so101",
    "max_relative_target": 0,  # max joint step per frame (0 = unlimited); a safety limit for the follower
    "follower_port": "/dev/ttyACM1",
    "leader_port": "/dev/ttyACM0",
    "follower_id": "makerworks_follower_arm",
    "leader_id": "makerworks_leader_arm",
}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "text/javascript",
    ".urdf": "application/xml",
    ".stl": "model/stl",
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text()))
    except (OSError, ValueError):
        pass
    return cfg


def list_calibrations():
    out = {}
    for kind, d in CAL_DIRS.items():
        files = []
        for f in sorted(d.glob("*.json")) if d.exists() else []:
            try:
                data = json.loads(f.read_text())
                joints = {
                    j: {k: v.get(k) for k in ("id", "homing_offset", "range_min", "range_max")}
                    for j, v in data.items()
                }
            except (OSError, ValueError, AttributeError):
                joints = {}
            st = f.stat()
            files.append({"id": f.stem, "modified": st.st_mtime, "size": st.st_size, "joints": joints})
        out[kind] = files
    return out


def list_recordings():
    files = sorted(REC_DIR.glob("teleop_*.csv"), reverse=True) if REC_DIR.exists() else []
    return [{"name": f.name, "size": f.stat().st_size, "modified": f.stat().st_mtime} for f in files]


def preview_recording(name, max_samples=300):
    f = REC_DIR / name
    if not (REC_NAME.match(name) and f.is_file()):
        return None
    try:
        with open(f, newline="", encoding="utf-8") as fp:
            reader = csv.reader(fp)
            header = next(reader, None)
            if not header:
                return None
            rows = list(reader)
        total_rows = len(rows)
        step = max(1, total_rows // max_samples) if total_rows > max_samples else 1
        sampled = rows[::step]
        duration = float(rows[-1][0]) if rows and len(rows[-1]) > 0 and rows[-1][0] else 0.0
        return {
            "name": name,
            "header": header,
            "total_rows": total_rows,
            "duration": round(duration, 2),
            "samples": sampled,
        }
    except Exception as e:
        return {"error": str(e)}


def strip_pos(d):
    return {k[:-4] if k.endswith(".pos") else k: round(v, 2) for k, v in d.items()}


def list_ports():
    return sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*"))


class Teleop:
    def __init__(self):
        self.lock = threading.Lock()
        self.thread = None
        self.stop_event = threading.Event()
        self.events = deque(maxlen=60)
        self.state = {
            "status": "idle",
            "error": None,
            "leader": {},
            "follower": {},
            "actual": {},
            "loop_ms": None,
            "started_at": None,
            "frames": 0,
            "recording": None,
            "rec_duration": 0,
            "rec_samples": 0,
        }
        self.record_flag = False

    def snapshot(self):
        with self.lock:
            return {**self.state, "events": list(self.events)}

    def _set(self, **kw):
        with self.lock:
            self.state.update(kw)

    def log(self, msg):
        with self.lock:
            self.events.append({"t": time.time(), "msg": msg})

    @property
    def running(self):
        return bool(self.thread and self.thread.is_alive())

    def start(self, cfg):
        if self.running:
            return
        self.stop_event.clear()
        self._set(
            status="connecting",
            error=None,
            leader={},
            follower={},
            actual={},
            loop_ms=None,
            frames=0,
            recording=None,
            rec_duration=0,
            rec_samples=0,
        )
        self.record_flag = False
        self.thread = threading.Thread(target=self._run, args=(cfg,), daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def _prepare(self, dev, label):
        # Avoid the interactive prompt: if motors differ from the saved file, write the file.
        if dev.is_calibrated:
            self.log(f"{label}: motor calibration matches saved file")
            return
        if not dev.calibration:
            raise RuntimeError(f"No calibration file for {label} ({dev.id}); run lerobot-calibrate first")
        dev.bus.write_calibration(dev.calibration)
        self.log(f"{label}: wrote saved calibration '{dev.id}' to motors")

    def _run(self, cfg):
        robot_cls, robot_cfg, leader_cls, leader_cfg = ARMS.get(cfg.get("robot_type"), ARMS["so101"])
        step = float(cfg.get("max_relative_target") or 0)
        robot = robot_cls(
            robot_cfg(port=cfg["follower_port"], id=cfg["follower_id"], max_relative_target=step or None)
        )
        leader = leader_cls(leader_cfg(port=cfg["leader_port"], id=cfg["leader_id"]))
        writer = fh = None
        try:
            self.log(f"Connecting leader {cfg['leader_id']} on {cfg['leader_port']}")
            leader.connect(calibrate=False)
            self.log(f"Connecting follower {cfg['follower_id']} on {cfg['follower_port']}")
            robot.connect(calibrate=False)
            self._prepare(leader, "leader")
            self._prepare(robot, "follower")
            if step:
                self.log(f"Safety: follower step limited to {step:g} per frame")
            self._set(status="running", started_at=time.time())
            self.log("Teleoperation running")
            period, n = 1 / 60, 0
            actual = {}
            while not self.stop_event.is_set():
                t0 = time.perf_counter()
                action = leader.get_action()
                sent = robot.send_action(action)
                n += 1
                upd = {"leader": strip_pos(action), "follower": strip_pos(sent), "frames": n}
                if n % 6 == 0:  # read true follower position at ~10 Hz
                    actual = strip_pos(robot.get_observation())
                    upd["actual"] = actual
                upd["loop_ms"] = round((time.perf_counter() - t0) * 1000, 2)
                self._set(**upd)

                if self.record_flag and writer is None:
                    REC_DIR.mkdir(exist_ok=True)
                    name = datetime.now().strftime("teleop_%Y%m%d_%H%M%S.csv")
                    fh = open(REC_DIR / name, "w", newline="")
                    writer = csv.writer(fh)
                    writer.writerow(
                        ["t"] + [f"{g}_{j}" for g in ("leader", "follower", "actual") for j in JOINTS]
                    )
                    rec_t0 = time.time()
                    rec_samples = 0
                    self._set(recording=name, rec_duration=0, rec_samples=0)
                    self.log(f"Recording started: {name}")
                elif not self.record_flag and writer is not None:
                    fh.close()
                    writer = fh = None
                    self._set(recording=None, rec_duration=0, rec_samples=0)
                    self.log("Recording saved")
                if writer is not None and n % 2 == 0:  # ~30 Hz
                    rec_samples += 1
                    row = [round(time.time() - rec_t0, 3)]
                    for src in (upd["leader"], upd["follower"], actual):
                        row += [src.get(j, "") for j in JOINTS]
                    writer.writerow(row)
                    if rec_samples % 6 == 0:
                        self._set(rec_duration=round(time.time() - rec_t0, 1), rec_samples=rec_samples)

                dt = time.perf_counter() - t0
                if dt < period:
                    time.sleep(period - dt)
            self._set(status="idle")
            self.log("Stopped (torque disabled)")
        except Exception as e:  # surface any hardware error to the UI
            self._set(status="error", error=f"{type(e).__name__}: {e}")
            self.log(f"Error: {type(e).__name__}: {e}")
        finally:
            if fh:
                fh.close()
                self._set(recording=None)
            for dev in (robot, leader):
                try:
                    if dev.is_connected:
                        dev.disconnect()
                except Exception:
                    pass


def make_handler(teleop):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def _send(self, code, body, ctype="application/json", cache="no-store"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            try:
                return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            except ValueError:
                return {}

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/api/state":
                return self._send(200, {**teleop.snapshot(), "joints": JOINTS})
            if path == "/api/config":
                return self._send(
                    200,
                    {"config": load_config(), "ports": list_ports(), "locked": teleop.running, "robot_types": list(ARMS)},
                )
            if path == "/api/ports":
                return self._send(200, {"ports": list_ports()})
            if path == "/api/recordings/preview":
                query = parse_qs(urlparse(self.path).query)
                name = query.get("name", [""])[0]
                prev = preview_recording(name)
                if prev:
                    return self._send(200, prev)
                return self._send(404, {"error": "Recording not found or invalid"})
            if path == "/api/recordings":
                return self._send(200, {"recordings": list_recordings()})
            if path.startswith("/recordings/"):
                name = path.split("/", 2)[2]
                f = REC_DIR / name
                if REC_NAME.match(name) and f.is_file():
                    data = f.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Content-Disposition", f'attachment; filename="{name}"')
                    self.end_headers()
                    self.wfile.write(data)
                    return
                return self._send(404, {"error": "not found"})
            if path == "/api/calibrations":
                return self._send(200, {**list_calibrations(), "dirs": {k: str(v) for k, v in CAL_DIRS.items()}})
            name = "index.html" if path == "/" else path.lstrip("/")
            f = (STATIC / name).resolve()
            if STATIC.resolve() in f.parents and f.is_file():
                # robot meshes never change: let the browser cache them
                cache = "max-age=86400" if f.suffix in (".stl", ".urdf") else "no-store"
                return self._send(
                    200, f.read_bytes(), CONTENT_TYPES.get(f.suffix, "application/octet-stream"), cache
                )
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path == "/api/start":
                teleop.start(load_config())
                return self._send(200, {"ok": True})
            if self.path == "/api/stop":
                teleop.stop()
                return self._send(200, {"ok": True})
            if self.path == "/api/record":
                if not teleop.running:
                    return self._send(409, {"error": "Start teleoperation first"})
                body = self._body()
                teleop.record_flag = bool(body.get("on"))
                return self._send(200, {"ok": True})
            if self.path == "/api/recordings/delete":
                name = self._body().get("name", "")
                f = REC_DIR / name
                if REC_NAME.match(name) and f.is_file():
                    f.unlink()
                    return self._send(200, {"ok": True})
                return self._send(404, {"error": "not found"})
            if self.path == "/api/config":
                if teleop.running:
                    return self._send(409, {"error": "Stop teleoperation before changing settings"})
                body = self._body()
                cfg = load_config()
                for k in DEFAULT_CONFIG:
                    v = body.get(k)
                    if k == "max_relative_target" and isinstance(v, (int, float)) and 0 <= v <= 100:
                        cfg[k] = v
                    elif k == "robot_type" and v in ARMS:
                        cfg[k] = v
                    elif k not in ("max_relative_target", "robot_type") and isinstance(v, str) and v.strip():
                        cfg[k] = v.strip()
                CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
                return self._send(200, {"config": cfg})
            self._send(404, {"error": "not found"})

    return Handler


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument(
        "--allow-lan",
        action="store_true",
        help="listen on all interfaces so phones/other PCs can open it (NO authentication: anyone on the "
        "network can move the arm)",
    )
    args = p.parse_args()
    if args.allow_lan:
        args.host = "0.0.0.0"
    teleop = Teleop()
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(teleop))
    print(f"Dashboard: http://127.0.0.1:{args.port}")
    if args.allow_lan:
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except OSError:
            ip = "<this-machine-ip>"
        print(f"LAN:       http://{ip}:{args.port}  (no authentication — trusted networks only)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        teleop.stop()


if __name__ == "__main__":
    main()
