import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";

const BOTGUARD_PAGE = "https://www.youtube.com/robots.txt";
const START_TIMEOUT_MS = 20_000;
const MINT_TIMEOUT_MS = 20_000;
const IDENTIFIER = /^[\w-]{1,128}$/;
const INTERPRETER_HOSTS = new Set(["www.google.com", "www.gstatic.com"]);

interface PendingMint {
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface MintResult {
  id: number;
  token?: string;
  error?: string;
}

export class PoTokenService {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private markReady: (() => void) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingMint>();

  constructor(private readonly preloadPath: string) {
    ipcMain.on("potoken:ready", (event) => {
      if (event.sender === this.window?.webContents) this.markReady?.();
    });
    ipcMain.on("potoken:result", (event: IpcMainEvent, result: MintResult) => this.settle(event, result));
    ipcMain.handle("potoken:interpreter", async (event, url: unknown) => {
      if (event.sender !== this.window?.webContents || typeof url !== "string") throw new Error("not allowed");
      const target = new URL(url);
      if (target.protocol !== "https:" || !INTERPRETER_HOSTS.has(target.hostname)) throw new Error("interpreter host not allowed");
      const response = await fetch(target, { signal: AbortSignal.timeout(START_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`interpreter download failed with ${response.status}`);
      return response.text();
    });
    ipcMain.handle("potoken:mint", (_event, identifier: unknown) => {
      if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) throw new Error("invalid identifier");
      return this.mint(identifier);
    });
  }

  private settle(event: IpcMainEvent, result: MintResult): void {
    if (event.sender !== this.window?.webContents) return;
    const entry = this.pending.get(result.id);
    if (!entry) return;
    this.pending.delete(result.id);
    clearTimeout(entry.timer);
    if (result.token) entry.resolve(result.token);
    else entry.reject(new Error(result.error || "PO token minting failed"));
  }

  private start(): Promise<void> {
    if (this.window && !this.window.isDestroyed() && this.ready) return this.ready;
    const win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 320,
      height: 240,
      webPreferences: {
        preload: this.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.window = win;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PO token window did not start")), START_TIMEOUT_MS);
      this.markReady = () => {
        clearTimeout(timer);
        resolve();
      };
      win.webContents.once("did-fail-load", (_event, _code, description) => {
        clearTimeout(timer);
        reject(new Error(`PO token window failed to load: ${description}`));
      });
    });
    this.ready = ready;
    ready.catch(() => this.destroy());
    win.on("closed", () => this.reset(win));
    void win.loadURL(BOTGUARD_PAGE);
    return ready;
  }

  private reset(win: BrowserWindow): void {
    if (this.window !== win) return;
    this.window = null;
    this.ready = null;
    this.markReady = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("PO token window closed"));
      this.pending.delete(id);
    }
  }

  async mint(identifier: string): Promise<string> {
    await this.start();
    const win = this.window;
    if (!win || win.isDestroyed()) throw new Error("PO token window is not available");
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("PO token minting timed out"));
      }, MINT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      win.webContents.send("potoken:mint", { id, identifier });
    });
  }

  destroy(): void {
    const win = this.window;
    if (win && !win.isDestroyed()) win.destroy();
    if (win) this.reset(win);
  }
}
