import { execFile } from "node:child_process";
import { ProtonClipboard } from "./ProtonClipboard";

const HYPRCTL_TIMEOUT = 2000;
const POE2_STEAM_CLASS = "steam_app_2694490";

interface HyprlandWindow {
  address?: string;
  at?: [number, number];
  class?: string;
  size?: [number, number];
  title?: string;
  xwayland?: boolean;
  pid?: number;
}

interface HyprlandCursorPosition {
  x: number;
  y: number;
}

export interface HyprlandGlobalHotkey {
  id: string;
  accelerator: string;
}

interface RuntimeBind {
  id: string;
  modifiers: string;
  key: string;
}

type HyprlandConfigProvider = "legacy" | "lua";

export class Hyprland {
  private runtimeBinds: RuntimeBind[] = [];
  private protonClipboard = new ProtonClipboard();
  private configProvider?: HyprlandConfigProvider;

  constructor(private windowTitle = "Path of Exile 2") {}

  updateWindowTitle(windowTitle: string) {
    this.windowTitle = windowTitle;
  }

  async isGameActive() {
    return (await this.activeGameWindow()) != null;
  }

  async copyItemText(accelerator: string, restoreClipboard: boolean) {
    const window = await this.activeGameWindow();
    if (!window?.address || !window.pid) {
      throw new Error("Path of Exile 2 is not the active Hyprland window");
    }

    const cursor = await this.cursorPosition().catch(() => undefined);
    const clipboard = await this.protonClipboard.capture(
      window.pid,
      async () => {
        await this.sendX11Shortcut(accelerator);
      },
      restoreClipboard,
    );

    return {
      clipboard,
      side: cursor ? itemSide(window, cursor) : undefined,
    };
  }

  async replaceGlobalBinds(hotkeys: HyprlandGlobalHotkey[]) {
    await this.clearGlobalBinds();

    try {
      for (const hotkey of hotkeys) {
        const { modifiers, key } = splitShortcut(hotkey.accelerator);
        const bind = { id: hotkey.id, modifiers, key: hyprlandKey(key) };
        await this.addGlobalBind(bind);
        this.runtimeBinds.push(bind);
      }
    } catch (error) {
      await this.clearGlobalBinds().catch(() => {});
      throw error;
    }
  }

  async clearGlobalBinds() {
    const binds = this.runtimeBinds;
    this.runtimeBinds = [];
    const results = await Promise.allSettled(
      binds.map(async (bind) => {
        await this.removeGlobalBind(bind);
      }),
    );

    let lastError: unknown;
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const bind = binds[index];
        if (!bind) return;
        this.runtimeBinds.push(bind);
        lastError = result.reason;
      }
    });

    if (lastError) {
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
    }
  }

  private async addGlobalBind(bind: RuntimeBind) {
    if ((await this.getConfigProvider()) === "lua") {
      await runHyprctl(["eval", addLuaGlobalBind(bind)]);
      return;
    }

    await runHyprctl([
      "keyword",
      "bindn",
      `${bind.modifiers},${bind.key},global,${portalShortcut(bind.id)}`,
    ]);
  }

  private async removeGlobalBind(bind: RuntimeBind) {
    if ((await this.getConfigProvider()) === "lua") {
      await runHyprctl(["eval", removeLuaGlobalBind(bind.id)]);
      return;
    }

    await runHyprctl(["keyword", "unbind", `${bind.modifiers},${bind.key}`]);
  }

  private async getConfigProvider(): Promise<HyprlandConfigProvider> {
    if (this.configProvider) return this.configProvider;

    const status = await runHyprctl(["status"]).catch(() => "");
    this.configProvider = /configProvider:\s*lua\b/i.test(status)
      ? "lua"
      : "legacy";
    return this.configProvider;
  }

  private async activeGameWindow() {
    const output = await runHyprctl(["-j", "activewindow"]);
    const window = JSON.parse(output) as HyprlandWindow;
    const isPoe2 =
      window.class?.toLowerCase() === POE2_STEAM_CLASS ||
      (window.xwayland === true && window.title === this.windowTitle);
    return isPoe2 ? window : null;
  }

  private async cursorPosition() {
    const output = await runHyprctl(["-j", "cursorpos"]);
    return JSON.parse(output) as HyprlandCursorPosition;
  }

  private async sendX11Shortcut(accelerator: string) {
    const output = await runCommand("xdotool", [
      "search",
      "--onlyvisible",
      "--class",
      POE2_STEAM_CLASS,
    ]);
    const windowId = output.trim().split("\n").filter(Boolean).at(-1);
    if (!windowId) throw new Error("Could not find the PoE2 XWayland window");

    await runCommand("xdotool", [
      "key",
      "--window",
      windowId,
      "--clearmodifiers",
      xdotoolShortcut(accelerator),
    ]);
  }
}

function addLuaGlobalBind(bind: RuntimeBind) {
  const id = luaString(bind.id);
  const shortcut = luaString(
    [...bind.modifiers.split(" ").filter(Boolean), bind.key].join(" + "),
  );
  const portalAction = luaString(portalShortcut(bind.id));
  return [
    "_G.__ee2_hotkeys = _G.__ee2_hotkeys or {}",
    `local old = _G.__ee2_hotkeys[${id}]`,
    "if old then old:remove() end",
    `_G.__ee2_hotkeys[${id}] = hl.bind(${shortcut}, hl.dsp.global(${portalAction}), { non_consuming = true })`,
  ].join("; ");
}

function removeLuaGlobalBind(id: string) {
  const key = luaString(id);
  return [
    "local binds = _G.__ee2_hotkeys",
    `if binds then local bind = binds[${key}]`,
    `if bind then bind:remove(); binds[${key}] = nil end end`,
  ].join("; ");
}

function portalShortcut(id: string) {
  return `exiled-exchange-2:${id}`;
}

function luaString(value: string) {
  return JSON.stringify(value);
}

function itemSide(
  window: HyprlandWindow,
  cursor: HyprlandCursorPosition,
): "stash" | "inventory" | undefined {
  if (!window.at || !window.size) return undefined;
  return cursor.x > window.at[0] + window.size[0] / 2 ? "inventory" : "stash";
}

function xdotoolShortcut(accelerator: string) {
  const names: Record<string, string> = {
    Ctrl: "ctrl",
    Alt: "alt",
    Shift: "shift",
    Meta: "super",
    Super: "super",
  };
  return accelerator
    .split(" + ")
    .map((key) => names[key] ?? key.toLowerCase())
    .join("+");
}

function splitShortcut(accelerator: string) {
  const parts = accelerator.split(" + ").map((part) => part.trim());
  const key = parts.pop() ?? "";
  const modifierList = parts.map(hyprlandModifier);
  return { modifiers: modifierList.join(" "), key };
}

function hyprlandModifier(modifier: string) {
  if (modifier === "Ctrl") return "CTRL";
  if (modifier === "Alt") return "ALT";
  if (modifier === "Shift") return "SHIFT";
  if (modifier === "Meta" || modifier === "Super") return "SUPER";
  return modifier.toUpperCase();
}

function hyprlandKey(key: string) {
  if (key === "Space") return "SPACE";
  if (key === "Enter") return "RETURN";
  if (key === "Escape") return "ESCAPE";
  if (key === "ArrowUp") return "UP";
  if (key === "ArrowDown") return "DOWN";
  if (key === "ArrowLeft") return "LEFT";
  if (key === "ArrowRight") return "RIGHT";
  return key.toUpperCase();
}

async function runHyprctl(args: string[]): Promise<string> {
  const output = await runCommand("hyprctl", args);
  if (/^(?:error:|keyword can't work)/i.test(output.trim())) {
    throw new Error(output.trim());
  }
  return output;
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: HYPRCTL_TIMEOUT },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr.trim() || error.message || `${command} command failed`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}
