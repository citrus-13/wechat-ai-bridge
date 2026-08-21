#!/usr/bin/env python3
"""Conservative X11 driver for one dedicated WeChat group.

The driver intentionally exposes only four commands: check, poll, send, and
screenshot. It never scans the contact list and only opens the exact group name
configured in WECHAT_TARGET_GROUP.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def env_list(name: str) -> list[str]:
    return [part.strip() for part in os.environ.get(name, "").split(",") if part.strip()]


def env_rect(name: str, default: str) -> tuple[int, int, int, int]:
    values = [int(value.strip()) for value in os.environ.get(name, default).split(",")]
    if len(values) != 4 or any(value < 0 for value in values):
        raise RuntimeError(f"{name} must be x,y,width,height")
    return tuple(values)  # type: ignore[return-value]


def env_point(name: str, default: str) -> tuple[int, int]:
    values = [int(value.strip()) for value in os.environ.get(name, default).split(",")]
    if len(values) != 2 or any(value < 0 for value in values):
        raise RuntimeError(f"{name} must be x,y")
    return tuple(values)  # type: ignore[return-value]


DISPLAY = os.environ.get("DISPLAY", ":99")
WINDOW_TITLE = os.environ.get("WECHAT_WINDOW_TITLE", "微信")
TARGET_GROUP = os.environ.get("WECHAT_TARGET_GROUP", "").strip()
AI_NAME = os.environ.get("WECHAT_AI_NAME", "AI").strip()
ALLOWED_SENDERS = env_list("WECHAT_ALLOWED_SENDERS")
STATE_PATH = Path(os.environ.get("WECHAT_UI_STATE", "/data/wechat-ui-state.json"))
SCREENSHOT_PATH = Path(os.environ.get("WECHAT_UI_SCREENSHOT", "/data/wechat-last.png"))
WINDOW_GEOMETRY = env_rect("WECHAT_WINDOW_GEOMETRY", "0,0,1280,800")
CHAT_RECT = env_rect("WECHAT_CHAT_RECT", "300,80,960,500")
INPUT_POINT = env_point("WECHAT_INPUT_POINT", "800,700")
OCR_LANG = os.environ.get("WECHAT_OCR_LANG", "chi_sim+eng")


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False))


def run(args: list[str], *, input_text: str | None = None, timeout: int = 15) -> str:
    result = subprocess.run(
        args,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
        env={**os.environ, "DISPLAY": DISPLAY},
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"{' '.join(args[:2])}: {detail}")
    return result.stdout


def find_window() -> str:
    output = run(["xdotool", "search", "--name", WINDOW_TITLE])
    windows = [line.strip() for line in output.splitlines() if line.strip()]
    if not windows:
        raise RuntimeError(f"WeChat window not found by title: {WINDOW_TITLE}")
    return windows[-1]


def prepare_window() -> tuple[str, int, int]:
    window = find_window()
    x, y, width, height = WINDOW_GEOMETRY
    run(["xdotool", "windowactivate", "--sync", window])
    run(["xdotool", "windowmove", window, str(x), str(y)])
    run(["xdotool", "windowsize", window, str(width), str(height)])
    return window, x, y


def set_clipboard(text: str) -> None:
    run(["xclip", "-selection", "clipboard"], input_text=text)


def open_target_group() -> tuple[str, int, int]:
    if not TARGET_GROUP:
        raise RuntimeError("WECHAT_TARGET_GROUP is empty")
    window, x, y = prepare_window()
    set_clipboard(TARGET_GROUP)
    run(["xdotool", "key", "--window", window, "ctrl+f"])
    time.sleep(0.2)
    run(["xdotool", "key", "--window", window, "ctrl+v"])
    time.sleep(0.7)
    run(["xdotool", "key", "--window", window, "Return"])
    time.sleep(0.8)
    return window, x, y


def capture_chat() -> Path:
    _, window_x, window_y = open_target_group()
    x, y, width, height = CHAT_RECT
    SCREENSHOT_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    run([
        "import",
        "-window",
        "root",
        "-crop",
        f"{width}x{height}+{window_x + x}+{window_y + y}",
        str(SCREENSHOT_PATH),
    ])
    os.chmod(SCREENSHOT_PATH, 0o600)
    return SCREENSHOT_PATH


def ocr_lines(image_path: Path) -> list[dict]:
    output = run([
        "tesseract", str(image_path), "stdout", "-l", OCR_LANG,
        "--psm", "6", "tsv",
    ], timeout=25)
    words: dict[tuple[str, str, str], list[dict]] = {}
    for row in csv.DictReader(io.StringIO(output), delimiter="\t"):
        text = (row.get("text") or "").strip()
        if not text:
            continue
        try:
            confidence = float(row.get("conf") or -1)
            if confidence < 20:
                continue
            left = int(row["left"])
            top = int(row["top"])
            width = int(row["width"])
            height = int(row["height"])
        except (ValueError, KeyError):
            continue
        key = (row.get("block_num", ""), row.get("par_num", ""), row.get("line_num", ""))
        words.setdefault(key, []).append({
            "text": text, "left": left, "top": top, "width": width, "height": height,
        })

    lines = []
    for items in words.values():
        items.sort(key=lambda item: item["left"])
        left = min(item["left"] for item in items)
        top = min(item["top"] for item in items)
        right = max(item["left"] + item["width"] for item in items)
        bottom = max(item["top"] + item["height"] for item in items)
        lines.append({
            "text": " ".join(item["text"] for item in items),
            "left": left,
            "top": top,
            "right": right,
            "bottom": bottom,
        })
    return sorted(lines, key=lambda line: (line["top"], line["left"]))


def normalize(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split()).strip()


def extract_events(lines: list[dict]) -> list[dict]:
    allowed = {normalize(sender): sender for sender in ALLOWED_SENDERS}
    trigger_variants = (f"@{AI_NAME}", f"＠{AI_NAME}", f"@ {AI_NAME}", f"＠ {AI_NAME}")
    events: list[dict] = []
    for index, line in enumerate(lines):
        text = normalize(line["text"])
        if not any(trigger in text for trigger in trigger_variants):
            continue
        sender = ""
        for previous in reversed(lines[max(0, index - 4):index]):
            candidate = normalize(previous["text"])
            vertical_gap = line["top"] - previous["bottom"]
            if vertical_gap > 120:
                break
            if candidate in allowed and previous["left"] < CHAT_RECT[2] * 0.68:
                sender = allowed[candidate]
                break
        if not sender:
            continue

        message_lines = [text]
        bottom = line["bottom"]
        for following in lines[index + 1:index + 4]:
            gap = following["top"] - bottom
            candidate = normalize(following["text"])
            if gap > 45 or candidate in allowed or following["left"] > CHAT_RECT[2] * 0.72:
                break
            message_lines.append(candidate)
            bottom = following["bottom"]
        message = normalize(" ".join(message_lines))
        digest = hashlib.sha256(f"{TARGET_GROUP}\0{sender}\0{message}".encode()).hexdigest()[:32]
        events.append({
            "id": f"ui-{digest}",
            "group": TARGET_GROUP,
            "sender": sender,
            "text": message,
            "createdAt": int(time.time() * 1000),
        })
    return events


def read_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"initialized": False, "seen": []}
    except (OSError, json.JSONDecodeError):
        return {"initialized": False, "seen": []}


def write_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=STATE_PATH.parent, delete=False) as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    os.chmod(temporary, 0o600)
    temporary.replace(STATE_PATH)


def poll() -> None:
    events = extract_events(ocr_lines(capture_chat()))
    state = read_state()
    seen = list(dict.fromkeys(state.get("seen", [])))
    seen_set = set(seen)
    fresh = [] if not state.get("initialized") else [event for event in events if event["id"] not in seen_set]
    for event in events:
        if event["id"] not in seen_set:
            seen.append(event["id"])
            seen_set.add(event["id"])
    write_state({"initialized": True, "seen": seen[-300:]})
    emit({"ok": True, "events": fresh, "recognized": len(events)})


def send(encoded: str) -> None:
    text = base64.b64decode(encoded, validate=True).decode("utf-8").strip()
    if not text:
        raise RuntimeError("refusing to send an empty message")
    window, window_x, window_y = open_target_group()
    set_clipboard(text)
    input_x, input_y = INPUT_POINT
    run(["xdotool", "mousemove", str(window_x + input_x), str(window_y + input_y), "click", "1"])
    run(["xdotool", "key", "--window", window, "ctrl+v"])
    time.sleep(0.15)
    run(["xdotool", "key", "--window", window, "Return"])
    emit({"ok": True})


def check() -> None:
    errors = []
    for command in ("xdotool", "xclip", "import", "tesseract"):
        if not shutil.which(command):
            errors.append(f"missing command: {command}")
    if not TARGET_GROUP:
        errors.append("WECHAT_TARGET_GROUP is empty")
    if not AI_NAME:
        errors.append("WECHAT_AI_NAME is empty")
    if not ALLOWED_SENDERS:
        errors.append("WECHAT_ALLOWED_SENDERS is empty")
    if not errors:
        try:
            find_window()
        except Exception as error:  # The exact message is useful during deployment.
            errors.append(str(error))
    emit({"ok": not errors, "errors": errors, "display": DISPLAY})


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "check"
    if command == "check":
        check()
    elif command == "poll":
        poll()
    elif command == "send":
        if len(sys.argv) != 3:
            raise RuntimeError("send requires one base64 argument")
        send(sys.argv[2])
    elif command == "screenshot":
        emit({"ok": True, "path": str(capture_chat())})
    else:
        raise RuntimeError(f"unknown command: {command}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"ok": False, "error": str(error)})
        raise SystemExit(1)
