import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";

const READY_MARKER = Buffer.from("EE2_CLIPBOARD_READY_V1\n");
const HELPER_START_TIMEOUT = 7000;
const HELPER_SESSION_TIMEOUT = 12000;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const POE2_STEAM_APP_ID = "2694490";
const execFileAsync = promisify(execFile);

class RetryableCaptureError extends Error {}

class HelperExitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

export class ProtonClipboard {
  async capture(
    gamePid: number,
    triggerCopy: () => Promise<void>,
    restore: boolean,
  ) {
    const proton = await protonEnvironment(gamePid);
    const helper = helperPath();
    await fs.access(helper, constants.R_OK).catch((error: unknown) => {
      throw new Error(
        `Proton clipboard helper is unavailable at ${helper}: ${errorMessage(error)}`,
      );
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await runHelper(proton, helper, triggerCopy, restore);
        if (!isPoeItemText(text)) {
          throw new RetryableCaptureError(
            "Proton clipboard helper returned invalid item text",
          );
        }
        return text;
      } catch (error) {
        const failure =
          error instanceof HelperExitError && error.code === 3
            ? new RetryableCaptureError(
                "Proton clipboard helper found no item text",
              )
            : error;
        if (attempt === 0 && failure instanceof RetryableCaptureError) continue;
        throw failure;
      }
    }

    throw new Error("Proton clipboard capture failed");
  }
}

async function runHelper(
  proton: Awaited<ReturnType<typeof protonEnvironment>>,
  helper: string,
  triggerCopy: () => Promise<void>,
  restore: boolean,
) {
  const args = ["--capture", ...(restore ? ["--restore"] : [])];
  const child = spawn(proton.wine, [helper, ...args], {
    env: {
      ...process.env,
      WINEPREFIX: proton.prefix,
      WINEDEBUG: "-all",
      ...(proton.xdgDataDirs ? { XDG_DATA_DIRS: proton.xdgDataDirs } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return await new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let ready = false;
    let triggerError: Error | undefined;
    let triggerPromise: Promise<void> | undefined;
    let pendingError: Error | undefined;
    let timeout = setTimeout(() => {
      stop(new Error("Proton clipboard helper startup timed out"));
    }, HELPER_START_TIMEOUT);

    const stop = (error: Error) => {
      if (pendingError) return;
      pendingError = error;
      child.kill("SIGKILL");
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        stop(new Error("Proton clipboard helper produced too much stderr"));
        return;
      }
      stderr.push(chunk);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > READY_MARKER.length + MAX_PAYLOAD_BYTES) {
        stop(new Error("Proton clipboard helper payload is too large"));
        return;
      }
      stdout.push(chunk);

      if (!ready) {
        const output = Buffer.concat(stdout, stdoutBytes);
        const prefixLength = Math.min(output.length, READY_MARKER.length);
        if (
          !output
            .subarray(0, prefixLength)
            .equals(READY_MARKER.subarray(0, prefixLength))
        ) {
          stop(new Error("Proton clipboard helper sent an invalid protocol"));
          return;
        }
        if (output.length >= READY_MARKER.length) {
          ready = true;
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            stop(new Error("Proton clipboard helper session timed out"));
          }, HELPER_SESSION_TIMEOUT);
          triggerPromise = Promise.resolve()
            .then(triggerCopy)
            .then(() => {
              child.stdin.end("G");
            })
            .catch((error: unknown) => {
              triggerError = toError(error);
              child.stdin.end();
            });
        }
      }
    });
    child.stdin.on("error", (error) => {
      triggerError ??= error;
    });
    child.on("error", (error) => {
      stop(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timeout);
      await triggerPromise;
      if (pendingError) {
        reject(pendingError);
        return;
      }
      if (triggerError) {
        reject(triggerError);
        return;
      }
      if (code === 0) {
        if (!ready) {
          reject(new Error("Proton clipboard helper never became ready"));
          return;
        }
        try {
          resolve(
            UTF8_DECODER.decode(
              Buffer.concat(stdout, stdoutBytes).subarray(READY_MARKER.length),
            ),
          );
        } catch (error) {
          reject(
            new Error(
              `Proton clipboard helper returned invalid UTF-8: ${errorMessage(error)}`,
            ),
          );
        }
      } else {
        const message = Buffer.concat(stderr, stderrBytes)
          .toString("utf8")
          .trim();
        reject(
          new HelperExitError(
            message || `Proton clipboard helper exited with code ${code}`,
            code,
          ),
        );
      }
    });
  });
}

function isPoeItemText(text: string) {
  if (
    !text ||
    text.includes("\0") ||
    Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES
  ) {
    return false;
  }

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const separator = lines.indexOf("--------");
  if (separator < 0 || !lines[0].includes(":")) return false;

  const headerLines = lines.slice(0, separator).filter(Boolean);
  const contentLines = lines.slice(separator + 1).filter(Boolean);
  return headerLines.length >= 2 && contentLines.length > 0;
}

async function protonEnvironment(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid Path of Exile process ID: ${pid}`);
  }

  const entries = await fs
    .readFile(`/proc/${pid}/environ`, "utf8")
    .then((contents) => parseEnvironment(contents))
    .catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      return [];
    });
  const environment = new Map(entries);
  const compatDataPath = environment.get("STEAM_COMPAT_DATA_PATH");
  let prefix =
    environment.get("WINEPREFIX") ||
    (compatDataPath ? path.join(compatDataPath, "pfx") : undefined);
  let toolPath = environment
    .get("STEAM_COMPAT_TOOL_PATHS")
    ?.split(":")
    .find(Boolean);
  if (!prefix || !toolPath) {
    const discovered = await discoverProtonEnvironment();
    prefix ??= discovered.prefix;
    toolPath ??= discovered.toolPath;
  }
  if (!prefix || !toolPath) {
    throw new Error("Could not determine the running Proton environment");
  }
  const resolvedPrefix = path.resolve(prefix);
  const wine = path.resolve(toolPath, "files", "bin", "wine");
  await Promise.all([
    fs.access(resolvedPrefix, constants.R_OK),
    fs.access(wine, constants.X_OK),
  ]).catch((error: unknown) => {
    throw new Error(
      `Proton environment is unavailable: ${errorMessage(error)}`,
    );
  });
  return {
    prefix: resolvedPrefix,
    wine,
    xdgDataDirs: environment.get("XDG_DATA_DIRS"),
  };
}

function parseEnvironment(contents: string) {
  return contents
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      return separator > 0
        ? [[entry.slice(0, separator), entry.slice(separator + 1)] as const]
        : [];
    });
}

async function discoverProtonEnvironment() {
  const [{ stdout }, steamLibraries] = await Promise.all([
    execFileAsync("ps", ["-eo", "args="], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    }),
    findSteamLibraries(),
  ]);
  const wineserver = stdout
    .split("\n")
    .find(
      (line) => line.includes("/files/") && /\/wineserver(?:\s|$)/.test(line),
    );
  const toolPath = wineserver?.match(
    /^(.*?)\/files\/.*\/wineserver(?:\s|$)/,
  )?.[1];

  let prefix: string | undefined;
  for (const library of steamLibraries) {
    const candidate = path.join(
      library,
      "steamapps",
      "compatdata",
      POE2_STEAM_APP_ID,
      "pfx",
    );
    if (await isAccessible(candidate)) {
      prefix = candidate;
      break;
    }
  }
  return { prefix, toolPath };
}

async function findSteamLibraries() {
  const steamRoot = path.join(os.homedir(), ".local", "share", "Steam");
  const libraries = new Set([steamRoot]);
  const registry = await fs
    .readFile(path.join(steamRoot, "config", "libraryfolders.vdf"), "utf8")
    .catch(() => "");
  for (const match of registry.matchAll(/"path"\s+"([^"]+)"/g)) {
    if (match[1]) libraries.add(match[1].replace(/\\\\/g, "\\"));
  }
  return [...libraries];
}

async function isAccessible(candidate: string) {
  return await fs
    .access(candidate, constants.R_OK)
    .then(() => true)
    .catch(() => false);
}

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "ee2-win-clipboard.exe")
    : path.join(__dirname, "..", "dist", "native", "ee2-win-clipboard.exe");
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown) {
  return toError(error).message;
}
