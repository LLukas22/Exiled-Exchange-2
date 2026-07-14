import { execFile } from "node:child_process";
import { UinputCopy } from "./UinputCopy";
import { ProtonClipboard } from "./ProtonClipboard";

const HYPRCTL_TIMEOUT = 2000;
const POE2_STEAM_CLASS = "steam_app_2694490";

interface HyprlandWindow {
  address?: string;
  class?: string;
  title?: string;
  xwayland?: boolean;
  pid?: number;
}

export interface HyprlandGlobalHotkey {
  id: string;
  accelerator: string;
}

interface RuntimeBind {
  modifiers: string;
  key: string;
}

export class Hyprland {
  private runtimeBinds: RuntimeBind[] = [];
  private uinputCopy = new UinputCopy();
  private protonClipboard = new ProtonClipboard();

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

    return await this.protonClipboard.capture(
      window.pid,
      async () => {
        await this.uinputCopy.sendShortcut(accelerator);
      },
      restoreClipboard,
    );
  }

  async replaceGlobalBinds(hotkeys: HyprlandGlobalHotkey[]) {
    await this.clearGlobalBinds();

    try {
      for (const hotkey of hotkeys) {
        const { modifiers, key } = splitShortcut(hotkey.accelerator);
        const bind = { modifiers, key: hyprlandKey(key) };
        await runHyprctl([
          "keyword",
          "bindn",
          `${bind.modifiers},${bind.key},global,exiled-exchange-2:${hotkey.id}`,
        ]);
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
        await runHyprctl([
          "keyword",
          "unbind",
          `${bind.modifiers},${bind.key}`,
        ]);
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

  stopInputHelper() {
    this.uinputCopy.stop();
  }

  private async activeGameWindow() {
    const output = await runHyprctl(["-j", "activewindow"]);
    const window = JSON.parse(output) as HyprlandWindow;
    const isPoe2 =
      window.class?.toLowerCase() === POE2_STEAM_CLASS ||
      (window.xwayland === true && window.title === this.windowTitle);
    return isPoe2 ? window : null;
  }
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
  return await runCommand("hyprctl", args);
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
