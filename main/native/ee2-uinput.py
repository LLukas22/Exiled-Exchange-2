#!/usr/bin/env python3

import json
import sys
import time

from evdev import UInput, ecodes


KEY_NAMES = {
    "Ctrl": "KEY_LEFTCTRL",
    "Alt": "KEY_LEFTALT",
    "Shift": "KEY_LEFTSHIFT",
    "Meta": "KEY_LEFTMETA",
    "Super": "KEY_LEFTMETA",
    "Space": "KEY_SPACE",
    "Enter": "KEY_ENTER",
    "Escape": "KEY_ESC",
    "ArrowUp": "KEY_UP",
    "ArrowDown": "KEY_DOWN",
    "ArrowLeft": "KEY_LEFT",
    "ArrowRight": "KEY_RIGHT",
}


def key_code(name: str) -> int:
    evdev_name = KEY_NAMES.get(name, f"KEY_{name.upper()}")
    code = ecodes.ecodes.get(evdev_name)
    if not isinstance(code, int):
        raise ValueError(f"unsupported key: {name}")
    return code


def send_shortcut(device: UInput, accelerator: str) -> None:
    keys = accelerator.split(" + ")
    held = [key_code(key) for key in keys if key != "C"]
    copy_key = key_code("C")

    try:
        for code in held:
            device.write(ecodes.EV_KEY, code, 1)
        device.syn()
        time.sleep(0.03)

        device.write(ecodes.EV_KEY, copy_key, 1)
        device.syn()
        time.sleep(0.03)
        device.write(ecodes.EV_KEY, copy_key, 0)
        device.syn()
        time.sleep(0.03)
    finally:
        for code in reversed(held):
            device.write(ecodes.EV_KEY, code, 0)
        device.syn()


def main() -> None:
    key_codes = sorted({
        code
        for name, code in ecodes.ecodes.items()
        if name.startswith("KEY_")
        and isinstance(code, int)
        and 0 <= code <= ecodes.KEY_MAX
    })
    with UInput(
        {ecodes.EV_KEY: key_codes},
        name="Exiled Exchange 2 Copy",
        bustype=ecodes.BUS_USB,
    ) as device:
        time.sleep(0.25)
        print(json.dumps({"type": "ready"}), flush=True)

        for line in sys.stdin:
            request = json.loads(line)
            request_id = request.get("id")
            try:
                send_shortcut(device, request["accelerator"])
                response = {"id": request_id, "ok": True}
            except Exception as error:
                response = {"id": request_id, "ok": False, "error": str(error)}
            print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
