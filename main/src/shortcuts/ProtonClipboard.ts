import { app } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const READY_MARKER = "EE2_READY\n";

export class ProtonClipboard {
  async capture(
    gamePid: number,
    triggerCopy: () => Promise<void>,
    restore: boolean,
  ) {
    const proton = await protonEnvironment(gamePid);
    const helper = helperPath();
    const child = spawn(
      proton.wine,
      [helper, ...(restore ? ["--restore"] : [])],
      {
        env: {
          ...process.env,
          WINEPREFIX: proton.prefix,
          WINEDLLPATH: path.dirname(helper),
          XDG_DATA_DIRS: proton.xdgDataDirs,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let triggered = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Proton clipboard helper timed out"));
      }, 5000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!triggered && stdout.startsWith(READY_MARKER)) {
          triggered = true;
          triggerCopy().catch((error) => {
            child.kill();
            reject(error);
          });
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0 && stdout.startsWith(READY_MARKER)) {
          resolve(stdout.slice(READY_MARKER.length));
        } else {
          reject(
            new Error(
              stderr.trim() ||
                `Proton clipboard helper exited with code ${code}`,
            ),
          );
        }
      });
    });
  }
}

async function protonEnvironment(pid: number) {
  const entries = (await fs.readFile(`/proc/${pid}/environ`, "utf8"))
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    });
  const environment = Object.fromEntries(entries);
  const prefix = environment.WINEPREFIX;
  const toolPath = environment.STEAM_COMPAT_TOOL_PATHS?.split(":")[0];
  if (!prefix || !toolPath) {
    throw new Error("Could not determine the running Proton environment");
  }
  return {
    prefix,
    wine: path.join(toolPath, "files", "bin", "wine"),
    xdgDataDirs: environment.XDG_DATA_DIRS,
  };
}

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "ee2-win-clipboard.exe.so")
    : path.join(__dirname, "..", "dist", "native", "ee2-win-clipboard.exe.so");
}
