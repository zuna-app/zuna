#!/usr/bin/env python3
# Renders a page to a PNG of exactly <width> x <height> with headless Chrome, driven over the DevTools protocol:
#
#   python3 -I capture.py <chrome> <url> <width> <height> <out.png>
#
# Chrome's own --screenshot often catches the large 3D devices of the App Store art before their tiles are painted.
# Here the page gets its exact size, the capture waits for the page and its images, and Chrome is asked to draw
# nothing until all of it is rasterized. A 3D device is dozens of layers the size of the device; past Chrome's
# default GPU memory budget it quietly leaves tiles out (the front of a phone, half an iPad), so the budget is raised.
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time


def main() -> None:
    chrome, url, width, height, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    # Chrome reads commands from its fd 3 and writes replies to its fd 4, each message ending in a NUL byte.
    to_chrome_read, to_chrome_write = os.pipe()
    from_chrome_read, from_chrome_write = os.pipe()
    profile = tempfile.mkdtemp()
    args = [chrome, "--headless=new", "--remote-debugging-pipe", f"--user-data-dir={profile}", "--hide-scrollbars",
            "--force-device-scale-factor=1", f"--window-size={width},{height}", "--run-all-compositor-stages-before-draw",
            "--force-gpu-mem-available-mb=4096", "--no-first-run", "--no-default-browser-check", "about:blank"]
    with open(os.devnull, "wb") as devnull:
        pid = os.posix_spawn(chrome, args, os.environ, file_actions=[
            (os.POSIX_SPAWN_DUP2, to_chrome_read, 3),
            (os.POSIX_SPAWN_DUP2, from_chrome_write, 4),
            (os.POSIX_SPAWN_DUP2, devnull.fileno(), 1),
            (os.POSIX_SPAWN_DUP2, devnull.fileno(), 2),
        ])
    os.close(to_chrome_read)
    os.close(from_chrome_write)
    writer = os.fdopen(to_chrome_write, "wb")
    reader = os.fdopen(from_chrome_read, "rb")
    buffer = b""
    next_id = 0

    def receive() -> dict:
        nonlocal buffer
        while b"\0" not in buffer:
            chunk = reader.read1(1 << 20)
            if not chunk:
                raise RuntimeError("Chrome closed the pipe")
            buffer += chunk
        message, buffer = buffer.split(b"\0", 1)
        return json.loads(message)

    def send(method: str, params: dict | None = None, session: str | None = None) -> dict:
        nonlocal next_id
        next_id += 1
        message = {"id": next_id, "method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        writer.write(json.dumps(message).encode() + b"\0")
        writer.flush()
        while True:
            reply = receive()
            if reply.get("id") == next_id:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply["result"]

    def wait_for(event: str, session: str) -> None:
        while True:
            message = receive()
            if message.get("method") == event and message.get("sessionId") == session:
                return

    try:
        target = send("Target.createTarget", {"url": "about:blank"})["targetId"]
        session = send("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        send("Emulation.setDeviceMetricsOverride",
             {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False}, session)
        send("Page.enable", session=session)
        send("Page.navigate", {"url": url}, session)
        wait_for("Page.loadEventFired", session)
        # Every image decoded, then a few frames for the layout and the 3D layers to settle.
        send("Runtime.evaluate", {"awaitPromise": True, "expression": """
            Promise.all([...document.images].map((image) => image.decode().catch(() => {})))
              .then(() => new Promise((done) => {
                let frames = 10;
                const tick = () => (--frames ? requestAnimationFrame(tick) : done());
                requestAnimationFrame(tick);
              }))"""}, session)
        time.sleep(1)
        shot = send("Page.captureScreenshot", {"format": "png", "fromSurface": True,
                                               "clip": {"x": 0, "y": 0, "width": width, "height": height, "scale": 1}},
                    session)
        with open(out, "wb") as file:
            file.write(base64.b64decode(shot["data"]))
        send("Browser.close")
    finally:
        writer.close()
        reader.close()
        os.waitpid(pid, 0)


if __name__ == "__main__":
    main()
