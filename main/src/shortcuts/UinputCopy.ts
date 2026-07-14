import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const START_TIMEOUT = 3000;
const COPY_TIMEOUT = 2000;

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class UinputCopy {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  async sendShortcut(accelerator: string) {
    await this.start();
    const child = this.child;
    if (!child) throw new Error("uinput copy helper is not running");

    const id = this.nextId++;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("uinput copy helper timed out"));
      }, COPY_TIMEOUT);
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, accelerator })}\n`);
    });
  }

  stop() {
    this.child?.kill();
    this.child = undefined;
    this.starting = undefined;
    this.rejectPending(new Error("uinput copy helper stopped"));
  }

  private async start() {
    if (this.child) return;
    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn("python3", [helperPath()], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      let ready = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("uinput copy helper did not become ready"));
      }, START_TIMEOUT);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", () => {
        clearTimeout(timeout);
        if (this.child === child) this.child = undefined;
        this.starting = undefined;
        this.rejectPending(
          new Error(stderr.trim() || "uinput copy helper exited"),
        );
        if (!ready)
          reject(new Error(stderr.trim() || "uinput copy helper exited"));
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const message = JSON.parse(line) as {
          type?: string;
          id?: number;
          ok?: boolean;
          error?: string;
        };
        if (message.type === "ready") {
          ready = true;
          clearTimeout(timeout);
          this.child = child;
          resolve();
          return;
        }
        if (message.id == null) return;
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timeout);
        this.pending.delete(message.id);
        if (message.ok) request.resolve();
        else request.reject(new Error(message.error || "uinput copy failed"));
      });
    }).finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "ee2-uinput.py")
    : path.join(__dirname, "..", "native", "ee2-uinput.py");
}
