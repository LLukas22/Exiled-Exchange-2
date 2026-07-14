import { clipboard, Clipboard } from "electron";
import { execFile, spawn } from "node:child_process";
import type { Logger } from "../RemoteLogger";

const POLL_DELAY = 48;
const POLL_LIMIT = 500;

// PoE must read clipboard within this timeframe,
// after that we restore clipboard.
// If game lagged for some reason, it will read
// wrong content (= restored clipboard, potentially containing password).
const RESTORE_AFTER = 120;

export class HostClipboard {
  private pollPromise?: Promise<string>;
  private elapsed = 0;
  private shouldRestore = false;
  private initialDelay = POLL_DELAY;

  private isRestored = true;

  get isPolling() {
    return this.pollPromise != null;
  }

  get restoreEnabled() {
    return this.shouldRestore;
  }

  constructor(private logger: Logger) {}

  updateOptions(restoreClipboard: boolean) {
    this.shouldRestore = restoreClipboard;
  }

  async readItemText(opts: { pollLimit?: number } = {}): Promise<string> {
    this.elapsed = 0;
    if (this.pollPromise) {
      return await this.pollPromise;
    }

    let textBefore = clipboard.readText();
    if (isPoeItem(textBefore)) {
      textBefore = "";
      if (process.platform !== "linux") {
        clipboard.writeText("");
      } else {
        // workaround KDE's "Prevent empty clipboard" feature
        // see https://github.com/SnosMe/awakened-poe-trade/issues/1790#issuecomment-4062830614 (please don't comment on, add issue in EE2 if discussion is requested)
        clipboard.writeText(`__EE2_FORCE_EMPTY_${Date.now()}`);
      }
    } else if (process.platform === "linux") {
      // workaround bug in Proton 10+ https://github.com/SnosMe/awakened-poe-trade/issues/1846 (please don't comment on, add issue in EE2 if discussion is requested)
      clipboard.writeText(`__EE2_FORCE_EMPTY_${Date.now()}`);
    }

    this.pollPromise = new Promise((resolve, reject) => {
      const poll = () => {
        const textAfter = clipboard.readText();

        if (isPoeItem(textAfter)) {
          if (this.shouldRestore) {
            clipboard.writeText(textBefore);
          }
          this.pollPromise = undefined;
          resolve(textAfter);
        } else {
          this.elapsed += POLL_DELAY;
          if (this.elapsed < (opts.pollLimit ?? POLL_LIMIT)) {
            setTimeout(poll, POLL_DELAY);
          } else {
            if (this.shouldRestore) {
              clipboard.writeText(textBefore);
            }
            this.pollPromise = undefined;

            if (!isPoeItem(textAfter)) {
              this.logger.write("warn [ClipboardPoller] No item text found.");
            }
            reject(new Error("Reading clipboard timed out"));
          }
        }
      };
      setTimeout(poll, this.initialDelay);
    });

    return await this.pollPromise;
  }

  async readItemTextWayland(
    triggerCopy: () => Promise<void>,
    opts: { pollLimit?: number } = {},
  ): Promise<string> {
    this.elapsed = 0;
    if (!this.pollPromise) {
      this.pollPromise = this.pollItemTextWayland(triggerCopy, opts).finally(
        () => {
          this.pollPromise = undefined;
        },
      );
    }
    return await this.pollPromise;
  }

  private async pollItemTextWayland(
    triggerCopy: () => Promise<void>,
    opts: { pollLimit?: number },
  ) {
    let textBefore = await readWaylandClipboard();
    if (isPoeItem(textBefore)) textBefore = "";

    await clearWaylandClipboard();
    await triggerCopy();

    const pollStartedAt = Date.now();
    return await new Promise<string>((resolve, reject) => {
      const poll = async () => {
        const textAfter = await readWaylandClipboard().catch(() => "");
        if (isPoeItem(textAfter)) {
          if (this.shouldRestore) {
            await writeWaylandClipboard(textBefore).catch(() => {});
          }
          resolve(textAfter);
          return;
        }

        if (Date.now() - pollStartedAt < (opts.pollLimit ?? POLL_LIMIT)) {
          setTimeout(() => {
            poll().catch(reject);
          }, POLL_DELAY);
          return;
        }

        if (this.shouldRestore) {
          await writeWaylandClipboard(textBefore).catch(() => {});
        }
        this.logger.write("warn [ClipboardPoller] No item text found.");
        reject(new Error("Reading clipboard timed out"));
      };
      setTimeout(() => {
        poll().catch(reject);
      }, this.initialDelay);
    });
  }

  // when `shouldRestore` is false, this function continues
  // to work as a throttler for callback
  restoreShortly(cb: (clipboard: Clipboard) => void) {
    // Not only do we not overwrite the clipboard, but we don't exec callback.
    // This throttling helps against disconnects from "Too many actions".
    if (!this.isRestored) {
      return;
    }

    this.isRestored = false;
    const saved = clipboard.readText();
    cb(clipboard);
    setTimeout(() => {
      if (this.shouldRestore) {
        clipboard.writeText(saved);
      }
      this.isRestored = true;
    }, RESTORE_AFTER);
  }

  updateDelay(delay: number) {
    this.initialDelay = delay;
  }
}

function isPoeItem(text: string) {
  return LANGUAGE_DETECTOR.find(
    ({ firstLine, uncutSkillGemLine }) =>
      text.startsWith(firstLine) || text.startsWith(uncutSkillGemLine),
  );
}

const LANGUAGE_DETECTOR = [
  {
    lang: "en",
    firstLine: "Item Class: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ru",
    firstLine: "Класс предмета: ",
    uncutSkillGemLine: "Редкость: ",
  },
  {
    lang: "fr",
    firstLine: "Classe d'objet: ",
    uncutSkillGemLine: "Rareté: ",
  },
  {
    lang: "de",
    firstLine: "Gegenstandsklasse: ",
    uncutSkillGemLine: "Seltenheit: ",
  },
  {
    lang: "pt",
    firstLine: "Classe do Item: ",
    uncutSkillGemLine: "Raridade: ",
  },
  {
    lang: "es",
    firstLine: "Clase de objeto: ",
    uncutSkillGemLine: "Rareza: ",
  },
  {
    lang: "th",
    firstLine: "ชนิดไอเทม: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ko",
    firstLine: "아이템 종류: ",
    uncutSkillGemLine: "아이템 희귀도: ",
  },
  {
    lang: "cmn-Hant",
    firstLine: "物品種類: ",
    uncutSkillGemLine: "稀有度: ",
  },
  {
    lang: "cmn-Hans",
    firstLine: "物品类别: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ja",
    firstLine: "アイテムクラス: ",
    uncutSkillGemLine: "レアリティ: ",
  },
];

async function readWaylandClipboard(): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      "wl-paste",
      ["--no-newline"],
      { encoding: "utf8", timeout: 1000 },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as unknown as { code?: string | number }).code;
          if (code === 1 || code === "1") {
            resolve("");
          } else {
            reject(new Error(stderr.trim() || error.message));
          }
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function writeWaylandClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    child.on("error", reject);
    child.on("close", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`wl-copy exited with code ${code}`));
      }
    });
    child.stdin.on("error", reject);
    child.stdin.end(text);
    child.unref();
    setTimeout(() => {
      settled = true;
      resolve();
    }, 50);
  });
}

async function clearWaylandClipboard(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("wl-copy", ["--clear"], { timeout: 1000 }, (error, _, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}
