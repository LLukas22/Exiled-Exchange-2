import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type Ee2WaylandHotkey = {
  id: string;
  accelerator: string;
};

type ParsedHotkey = Ee2WaylandHotkey & {
  parsed: {
    keyCode: string;
    modifiers: Array<"ctrl" | "shift" | "alt" | "meta">;
  };
};

export type Ee2WaylandHelperEvent =
  | { type: "ready"; devices: string[]; hotkeys: number }
  | { type: "configured"; hotkeys: number }
  | { type: "hotkey"; id: string; accelerator: string; timestamp: number }
  | {
      type: "copied";
      requestId: string;
      accelerator: string;
      timestamp: number;
    }
  | { type: "error"; code: string; message: string; requestId?: string }
  | { type: "exit"; code: number | null; signal: string | null };

type PendingCopy = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class Ee2WaylandHelper extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private hotkeys: Ee2WaylandHotkey[] = [];
  private pendingCopies = new Map<string, PendingCopy>();
  private nextRequestId = 1;

  async start(hotkeys: Ee2WaylandHotkey[]): Promise<void> {
    if (this.child) {
      throw new Error("EE2 Wayland helper is already running");
    }

    this.hotkeys = [...hotkeys];
    const helperPath = await stageRustHelperBinary(getRustHelperPath());
    const child = spawn("pkexec", [helperPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleError = (error: Error) => {
        if (!settled) {
          settled = true;
          this.child = undefined;
          reject(error);
        } else {
          this.emit("event", {
            type: "error",
            code: "SPAWN_ERROR",
            message: error.message,
          } satisfies Ee2WaylandHelperEvent);
        }
      };

      child.stdout.on("data", (chunk) => {
        try {
          for (const event of this.parseEvents(chunk)) {
            this.handleEvent(event);
            this.emit("event", event);
            if (event.type === "ready") settleReady();
            if (event.type === "error" && !settled) {
              settleError(new Error(event.message));
            }
          }
        } catch (error) {
          settleError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });

      child.stderr.on("data", (chunk) => {
        this.emit("event", {
          type: "error",
          code: "HELPER_STDERR",
          message: chunk.toString(),
        } satisfies Ee2WaylandHelperEvent);
      });

      child.once("error", settleError);
      child.once("exit", (code, signal) => {
        this.child = undefined;
        this.rejectPendingCopies(new Error("EE2 Wayland helper exited"));
        const event: Ee2WaylandHelperEvent = { type: "exit", code, signal };
        this.emit("event", event);
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `EE2 Wayland helper exited before ready: ${code ?? signal ?? "unknown"}`,
            ),
          );
        }
      });

      child.stdin.write(
        `${JSON.stringify({
          parentPid: process.pid,
          devices: hotkeys.length ? discoverEventDevices() : [],
          hotkeys: parseHotkeys(hotkeys),
          enableUinput: true,
        })}\n`,
      );
    });
  }

  setHotkeys(hotkeys: Ee2WaylandHotkey[]) {
    this.hotkeys = [...hotkeys];
    this.send({ type: "set", hotkeys: parseHotkeys(hotkeys) });
  }

  copyItemText(accelerator: string): Promise<void> {
    const requestId = `copy-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCopies.delete(requestId);
        reject(new Error("EE2 Wayland helper copy command timed out"));
      }, 1000);
      this.pendingCopies.set(requestId, { resolve, reject, timeout });
      try {
        this.send({ type: "copy", requestId, accelerator });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCopies.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  stop() {
    if (!this.child) return;
    this.send({ type: "exit" });
    this.child.kill("SIGTERM");
    this.child = undefined;
  }

  override on(
    event: "event",
    cb: (event: Ee2WaylandHelperEvent) => void,
  ): this {
    return super.on(event, cb);
  }

  private send(value: unknown) {
    if (!this.child) {
      throw new Error("EE2 Wayland helper is not running");
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private parseEvents(chunk: Buffer): Ee2WaylandHelperEvent[] {
    this.buffer += chunk.toString("utf8");
    const events: Ee2WaylandHelperEvent[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      events.push(normalizeEvent(JSON.parse(line)));
    }
    return events;
  }

  private handleEvent(event: Ee2WaylandHelperEvent) {
    if (event.type === "copied") {
      const pending = this.pendingCopies.get(event.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingCopies.delete(event.requestId);
      pending.resolve();
    } else if (event.type === "error" && event.requestId) {
      const pending = this.pendingCopies.get(event.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingCopies.delete(event.requestId);
      pending.reject(new Error(event.message));
    }
  }

  private rejectPendingCopies(error: Error) {
    for (const pending of this.pendingCopies.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingCopies.clear();
  }
}

function normalizeEvent(value: unknown): Ee2WaylandHelperEvent {
  if (!value || typeof value !== "object") {
    return {
      type: "error",
      code: "PROTOCOL_INVALID",
      message: "helper emitted a non-object event",
    };
  }

  const event = value as Record<string, unknown>;
  if (event.type === "ready" && Array.isArray(event.devices)) {
    return {
      type: "ready",
      devices: event.devices.filter(
        (device): device is string => typeof device === "string",
      ),
      hotkeys: typeof event.hotkeys === "number" ? event.hotkeys : 0,
    };
  }
  if (event.type === "configured" && typeof event.hotkeys === "number") {
    return { type: "configured", hotkeys: event.hotkeys };
  }
  if (
    event.type === "hotkey" &&
    typeof event.id === "string" &&
    typeof event.accelerator === "string" &&
    typeof event.timestamp === "number"
  ) {
    return {
      type: "hotkey",
      id: event.id,
      accelerator: event.accelerator,
      timestamp: event.timestamp,
    };
  }
  if (
    event.type === "copied" &&
    typeof event.requestId === "string" &&
    typeof event.accelerator === "string" &&
    typeof event.timestamp === "number"
  ) {
    return {
      type: "copied",
      requestId: event.requestId,
      accelerator: event.accelerator,
      timestamp: event.timestamp,
    };
  }
  if (
    event.type === "error" &&
    typeof event.code === "string" &&
    typeof event.message === "string"
  ) {
    return {
      type: "error",
      code: event.code,
      message: event.message,
      requestId:
        typeof event.requestId === "string" ? event.requestId : undefined,
    };
  }
  return {
    type: "error",
    code: "PROTOCOL_UNSUPPORTED_EVENT",
    message: "helper emitted an unsupported event type",
  };
}

function parseHotkeys(hotkeys: Ee2WaylandHotkey[]): ParsedHotkey[] {
  return hotkeys.map((hotkey) => ({
    ...hotkey,
    parsed: parseAccelerator(hotkey.accelerator),
  }));
}

function parseAccelerator(accelerator: string): ParsedHotkey["parsed"] {
  const modifiers: ParsedHotkey["parsed"]["modifiers"] = [];
  let keyCode: string | undefined;

  for (const part of accelerator.split("+").map((part) => part.trim())) {
    if (part === "Ctrl" || part === "Control") modifiers.push("ctrl");
    else if (part === "Shift") modifiers.push("shift");
    else if (part === "Alt") modifiers.push("alt");
    else if (part === "Meta" || part === "Super") modifiers.push("meta");
    else keyCode = keyToLinuxCode(part);
  }

  if (!keyCode) {
    throw new Error(
      `invalid accelerator without non-modifier key: ${accelerator}`,
    );
  }
  return { keyCode, modifiers };
}

function keyToLinuxCode(key: string): string {
  if (/^[A-Z]$/.test(key)) return `KEY_${key}`;
  if (/^[0-9]$/.test(key)) return `KEY_${key}`;
  if (/^F([1-9]|1[0-2])$/.test(key)) return `KEY_${key}`;
  if (/^Numpad[0-9]$/.test(key)) return `KEY_KP${key.slice("Numpad".length)}`;

  const map: Record<string, string> = {
    Space: "KEY_SPACE",
    Tab: "KEY_TAB",
    Home: "KEY_HOME",
    End: "KEY_END",
    PageUp: "KEY_PAGEUP",
    PageDown: "KEY_PAGEDOWN",
    Insert: "KEY_INSERT",
    Delete: "KEY_DELETE",
    Escape: "KEY_ESC",
    Enter: "KEY_ENTER",
    Backspace: "KEY_BACKSPACE",
    Period: "KEY_DOT",
    ArrowUp: "KEY_UP",
    ArrowDown: "KEY_DOWN",
    ArrowLeft: "KEY_LEFT",
    ArrowRight: "KEY_RIGHT",
    NumpadAdd: "KEY_KPPLUS",
    NumpadSubtract: "KEY_KPMINUS",
    NumpadMultiply: "KEY_KPASTERISK",
    NumpadDivide: "KEY_KPSLASH",
    NumpadDecimal: "KEY_KPDOT",
    MouseLeft: "BTN_LEFT",
    Mouse1: "BTN_LEFT",
    MouseRight: "BTN_RIGHT",
    Mouse2: "BTN_RIGHT",
    MouseMiddle: "BTN_MIDDLE",
    Mouse3: "BTN_MIDDLE",
    Mouse4: "BTN_SIDE",
    MouseBack: "BTN_SIDE",
    Mouse5: "BTN_EXTRA",
    MouseForward: "BTN_EXTRA",
  };
  const linuxCode = map[key];
  if (!linuxCode) throw new Error(`unsupported Wayland helper key: ${key}`);
  return linuxCode;
}

function discoverEventDevices(): string[] {
  return fs
    .readdirSync("/dev/input")
    .filter((entry) => /^event\d+$/.test(entry))
    .map((entry) => `/dev/input/${entry}`);
}

function getRustHelperPath(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "native",
      "ee2-wayland-helper",
    );
  }
  return path.join(__dirname, "native", "ee2-wayland-helper");
}

async function stageRustHelperBinary(sourcePath: string): Promise<string> {
  const dest = path.join(os.tmpdir(), "ee2-wayland-helper");
  await fsp.copyFile(sourcePath, dest);
  await fsp.chmod(dest, 0o755);
  return dest;
}
