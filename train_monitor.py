#!/usr/bin/env python3
"""Live training monitor for lerobot-train with terminal graphs and progress."""

import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import plotext as plt
from rich.console import Console
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.progress import BarColumn, Progress, TextColumn, TimeRemainingColumn
from rich.table import Table
from rich.text import Text


def parse_step_value(s: str) -> int:
    """Parse step strings like '1K', '2K', '200' into integers."""
    s = s.strip()
    if s.upper().endswith("K"):
        return int(float(s[:-1]) * 1000)
    return int(s)


def parse_log_line(line: str):
    """Parse a training log line into a dict of metrics."""
    pattern = (
        r"step:(\S+)\s+smpl:(\S+)\s+ep:(\S+)\s+epch:(\S+)\s+"
        r"loss:(\S+)\s+grdn:(\S+)\s+lr:(\S+)\s+updt_s:(\S+)\s+data_s:(\S+)"
    )
    m = re.search(pattern, line)
    if not m:
        return None

    # Extract timestamp
    ts_match = re.search(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", line)
    timestamp = datetime.strptime(ts_match.group(1), "%Y-%m-%d %H:%M:%S") if ts_match else datetime.now()

    return {
        "timestamp": timestamp,
        "step": parse_step_value(m.group(1)),
        "samples": m.group(2),
        "episodes": int(m.group(3)),
        "epoch": float(m.group(4)),
        "loss": float(m.group(5)),
        "grad_norm": float(m.group(6)),
        "lr": float(m.group(7)),
        "update_s": float(m.group(8)),
        "data_s": float(m.group(9)),
    }


def parse_total_steps(log_path: str) -> int:
    """Try to extract total steps from the config dump in the log."""
    with open(log_path) as f:
        for line in f:
            m = re.search(r"cfg\.steps=(\d+)", line)
            if m:
                return int(m.group(1))
            m = re.search(r"'steps':\s*(\d+)", line)
            if m:
                return int(m.group(1))
    return 300000  # default


def make_loss_plot(steps, losses, width=80, height=15):
    """Create a terminal loss plot using plotext."""
    plt.clf()
    plt.theme("dark")
    plt.plot_size(width, height)
    if len(steps) > 1:
        plt.plot(steps, losses, marker="braille", color="cyan")
        # Add a smoothed line if enough data
        if len(losses) >= 5:
            window = min(10, len(losses) // 2)
            smoothed = []
            for i in range(len(losses)):
                start = max(0, i - window + 1)
                smoothed.append(sum(losses[start : i + 1]) / (i - start + 1))
            plt.plot(steps, smoothed, marker="braille", color="yellow")
    elif len(steps) == 1:
        plt.scatter(steps, losses, marker="dot", color="cyan")
    plt.title("Training Loss")
    plt.xlabel("Step")
    plt.ylabel("Loss")
    return plt.build()


def make_grad_plot(steps, grads, width=80, height=12):
    """Create a terminal gradient norm plot."""
    plt.clf()
    plt.theme("dark")
    plt.plot_size(width, height)
    if len(steps) > 1:
        plt.plot(steps, grads, marker="braille", color="magenta")
    elif len(steps) == 1:
        plt.scatter(steps, grads, marker="dot", color="magenta")
    plt.title("Gradient Norm")
    plt.xlabel("Step")
    plt.ylabel("Grad Norm")
    return plt.build()


def build_dashboard(entries, total_steps):
    """Build the full dashboard output string."""
    if not entries:
        return "Waiting for training log data...\n"

    latest = entries[-1]
    first = entries[0]
    current_step = latest["step"]
    progress_pct = (current_step / total_steps) * 100

    # ETA calculation
    elapsed = (latest["timestamp"] - first["timestamp"]).total_seconds()
    steps_done = current_step - first["step"]
    if steps_done > 0 and elapsed > 0:
        steps_per_sec = steps_done / elapsed
        remaining_steps = total_steps - current_step
        eta_seconds = remaining_steps / steps_per_sec
        eta_td = timedelta(seconds=int(eta_seconds))
        finish_time = datetime.now() + timedelta(seconds=eta_seconds)
        eta_str = str(eta_td)
        finish_str = finish_time.strftime("%Y-%m-%d %H:%M:%S")
        speed_str = f"{steps_per_sec:.2f} steps/s"
    else:
        eta_str = "calculating..."
        finish_str = "calculating..."
        speed_str = "calculating..."

    # Build output
    console = Console(file=None, force_terminal=True, width=100)
    output_parts = []

    # Header
    output_parts.append("")
    output_parts.append("=" * 90)
    output_parts.append(
        f"  LEROBOT TRAINING MONITOR  |  Step {current_step:,} / {total_steps:,}"
        f"  |  {progress_pct:.2f}%"
    )
    output_parts.append("=" * 90)

    # Progress bar
    bar_width = 60
    filled = int(bar_width * progress_pct / 100)
    bar = "█" * filled + "░" * (bar_width - filled)
    output_parts.append(f"  [{bar}] {progress_pct:.2f}%")
    output_parts.append("")

    # Stats table
    output_parts.append("┌─────────────────────────────────────────────────────────────────────────────────────┐")
    output_parts.append(
        f"│  Loss: {latest['loss']:.4f}    │  Grad Norm: {latest['grad_norm']:.3f}"
        f"    │  LR: {latest['lr']:.1e}    │  Epoch: {latest['epoch']:.2f}       │"
    )
    output_parts.append(
        f"│  Speed: {speed_str:<14s}│  Update: {latest['update_s']:.3f}s"
        f"         │  Data: {latest['data_s']:.3f}s       │  Episodes: {latest['episodes']:<8d}│"
    )
    output_parts.append(
        f"│  ETA: {eta_str:<17s}│  Est. Finish: {finish_str:<22s}│  Samples: {latest['samples']:<10s}│"
    )
    output_parts.append("└─────────────────────────────────────────────────────────────────────────────────────┘")
    output_parts.append("")

    # Min/max loss
    all_losses = [e["loss"] for e in entries]
    min_loss = min(all_losses)
    max_loss = max(all_losses)
    min_step = entries[all_losses.index(min_loss)]["step"]
    output_parts.append(
        f"  Loss range: {min_loss:.4f} (step {min_step:,}) — {max_loss:.4f}"
        f"  |  Current: {latest['loss']:.4f}"
    )

    # Loss trend (last 5 entries)
    if len(entries) >= 2:
        recent = entries[-5:]
        trend_losses = [e["loss"] for e in recent]
        if trend_losses[-1] < trend_losses[0]:
            trend = "↓ decreasing"
        elif trend_losses[-1] > trend_losses[0]:
            trend = "↑ increasing"
        else:
            trend = "→ stable"
        output_parts.append(f"  Trend (last {len(recent)} logs): {trend}")
    output_parts.append("")

    # Loss plot
    steps = [e["step"] for e in entries]
    losses = [e["loss"] for e in entries]
    output_parts.append(make_loss_plot(steps, losses, width=90, height=15))
    output_parts.append("")

    # Gradient norm plot
    grads = [e["grad_norm"] for e in entries]
    output_parts.append(make_grad_plot(steps, grads, width=90, height=12))

    return "\n".join(output_parts)


def monitor(log_path: str, total_steps: int = None):
    """Main monitoring loop - tails the log file and updates dashboard."""
    log_path = Path(log_path)

    if total_steps is None:
        total_steps = parse_total_steps(str(log_path))

    print(f"Monitoring: {log_path}")
    print(f"Total steps: {total_steps:,}")
    print("Waiting for training data...")

    entries = []

    # First, parse any existing content
    if log_path.exists():
        with open(log_path) as f:
            for line in f:
                parsed = parse_log_line(line)
                if parsed:
                    entries.append(parsed)

    # Start tailing
    last_size = log_path.stat().st_size if log_path.exists() else 0

    while True:
        try:
            if log_path.exists():
                current_size = log_path.stat().st_size
                if current_size > last_size:
                    with open(log_path) as f:
                        f.seek(last_size)
                        new_data = f.read()
                    last_size = current_size

                    for line in new_data.splitlines():
                        parsed = parse_log_line(line)
                        if parsed:
                            entries.append(parsed)

                elif current_size < last_size:
                    # File was truncated/recreated - re-read
                    entries.clear()
                    with open(log_path) as f:
                        for line in f:
                            parsed = parse_log_line(line)
                            if parsed:
                                entries.append(parsed)
                    last_size = current_size

            # Clear and redraw
            print("\033[2J\033[H", end="")  # clear screen
            print(build_dashboard(entries, total_steps))

            # Check if training is done
            if entries and entries[-1]["step"] >= total_steps:
                print("\n  ✅ TRAINING COMPLETE!")
                break

            time.sleep(5)

        except KeyboardInterrupt:
            print("\nMonitor stopped.")
            break


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python train_monitor.py <log_file> [total_steps]")
        print("Example: python train_monitor.py training.log 300000")
        sys.exit(1)

    log_file = sys.argv[1]
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else None
    monitor(log_file, steps)
