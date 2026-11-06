# SO-101 Teleoperation Studio

A local web app for running, monitoring and visualizing **SO-101 leader/follower arm teleoperation**, with a
**3D digital twin** of both arms built from the official CAD. It sits on top of
[LeRobot](https://github.com/huggingface/lerobot) and talks to real hardware.

**Built by Ajay Ummadi ([MakerWorks Lab](https://github.com/MakerWorksLab)) with AI assistance.**
I set the product direction, supplied the real arms and photos, tested everything on my own hardware, and
designed and expanded the front-end UI (the "Teleoperation Cockpit" redesign). The backend, the first UI and the
3D digital twin were written with Claude Code.

## Features

- **Live teleoperation control** – start/stop the leader→follower loop at 60 Hz from the browser, E-Stop on `Esc`.
- **Live telemetry** – loop time, rate, uptime, tracking error (commanded vs measured follower position), per-joint
  bars and history graphs for leader, commanded and actual positions.
- **Session recording** – one-click CSV capture (~30 Hz) with a page to preview, download and delete recordings.
- **Calibration manager** – browse saved calibration files with per-joint values and choose which one to use. Saved
  calibration is written to the motors instead of triggering an accidental re-calibration.
- **Safety** – per-frame step limit for gentler starts, torque warnings, hardware errors shown in the UI.
- **3D digital twin** – drives a leader (teal, handle + trigger) and a follower (white, two-jaw gripper) from live
  joint data. Studio-style render with soft shadows, glossy servos, animated servo wires, red C-clamps, the driver
  board and handwritten port labels modelled from photos of the real setup. Split and ghost-overlay views, camera
  presets, and an idle demo animation.
- **Responsive, themed UI** – works on phone widths; light/dark theme.

## Tech

| Part | What |
|---|---|
| Backend | Python standard library only: threaded HTTP server, hardware thread, JSON API (`dashboard/server.py`) |
| Robot I/O | LeRobot `SO101Follower` / `SO101Leader` (Feetech STS3215 bus servos) |
| Frontend | Plain JavaScript single-page app (`static/app.js`, `static/app.css`) |
| 3D | Three.js: custom URDF loader, STL meshes, PBR materials, procedural studio lighting (`static/arm3d.js`) |

Engineering notes worth reading:

- The leader and follower CAD files use **different base orientations**, so the same reading turned them in opposite
  directions. This was diagnosed by measuring joint positions in the running scene; the fix aligns both arms to a
  shared frame and adds an automatic joint-direction check.
- STL files carry only flat per-face normals; the loader smooths them across shallow edges and keeps sharp creases so
  printed parts read as moulded plastic.
- Clamp, board and label placement was measured from the loaded meshes rather than guessed.

## Run it

```bash
source .venv/bin/activate
pip install "feetech-servo-sdk>=1.0.0,<2.0.0"      # motor SDK
python dashboard/server.py                          # http://127.0.0.1:8765
```

Stop any running `lerobot-teleoperate` first; only one program can own the serial ports. Use `--allow-lan` to open it
from a phone or another PC – there is **no authentication**, so only do that on a trusted network.

## Other project: Training monitor

`train_monitor.py` (repo root) – a live terminal dashboard for `lerobot-train` by Ajay Ummadi: tails the training log,
shows progress, ETA, loss/gradient-norm plots and a smoothed trend.

```bash
python train_monitor.py training.log 300000
```

## Credits and licenses

- **[LeRobot](https://github.com/huggingface/lerobot)** by Hugging Face – Apache-2.0. This project is a separate
  add-on and is not part of, or endorsed by, LeRobot.
- **SO-101 arm design, URDFs and STL meshes** (`dashboard/static/so101/`) – from
  [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100) (Apache-2.0). Meshes were obtained from
  the `Simulation/SO101` folder of that repository and from a copy bundled with the `lelab` tool.
- **[Three.js](https://threejs.org/)** – MIT, loaded from the jsDelivr CDN (the 3D view needs internet access).
- Built with AI assistance (Claude Code by Anthropic).

## License and copyright

Copyright 2026 Ajay Ummadi (MakerWorks Lab). The files I wrote (`dashboard/server.py`, `dashboard/static/app.js`, `app.css`, `arm3d.js`, `index.html` and `train_monitor.py`) are licensed under the Apache License, Version 2.0, the same license as the rest of this repository (see `LICENSE`). Third-party parts keep their own licenses, listed above.
