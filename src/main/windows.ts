// Pet window (transparent, frameless, always-on-top) and the Settings window.
import { BrowserWindow, screen, shell } from "electron";
import { join } from "node:path";

export const PET_PAD = 12;
/** Vertical room under the character for the quick chat bar + status line. */
export const CHAT_AREA_HEIGHT = 92;
export const MIN_PET_WINDOW_WIDTH = 280;

export function petWindowBounds(size: number): { width: number; height: number } {
  return {
    width: Math.max(MIN_PET_WINDOW_WIDTH, size + PET_PAD * 2),
    height: size + PET_PAD * 2 + CHAT_AREA_HEIGHT,
  };
}

export function createPetWindow(params: {
  preload: string;
  html: string;
  size: number;
  alwaysOnTop: boolean;
  position?: { x: number; y: number };
}): BrowserWindow {
  const { width, height } = petWindowBounds(params.size);
  const pos = clampToScreen(params.position, width, height) ?? defaultPosition(width, height);
  const win = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false, // we move it ourselves while dragging the character
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: params.alwaysOnTop,
    title: "OpenClaw Pet",
    show: false,
    backgroundColor: "#00000000",
    roundedCorners: false,
    webPreferences: {
      preload: params.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
      spellcheck: false,
      devTools: !!process.env.OPENCLAW_PET_DEVTOOLS,
    },
  });
  applyAlwaysOnTop(win, params.alwaysOnTop);
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadFile(params.html);
  win.once("ready-to-show", () => win.show());
  return win;
}

export function applyAlwaysOnTop(win: BrowserWindow, on: boolean): void {
  // "floating" keeps the pet above normal windows without fighting menus/dialogs.
  win.setAlwaysOnTop(on, on ? "floating" : "normal");
}

export function createSettingsWindow(params: { preload: string; html: string; parentIcon?: string }): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 620,
    minHeight: 520,
    title: "OpenClaw Pet Settings",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f6f6f8",
    icon: params.parentIcon,
    webPreferences: {
      preload: params.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: !!process.env.OPENCLAW_PET_DEVTOOLS,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadFile(params.html);
  win.once("ready-to-show", () => win.show());
  return win;
}

function defaultPosition(width: number, height: number): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - width - 40,
    y: workArea.y + workArea.height - height - 40,
  };
}

export function clampToScreen(
  pos: { x: number; y: number } | undefined,
  width: number,
  height: number,
): { x: number; y: number } | undefined {
  if (!pos) return undefined;
  const display = screen.getDisplayNearestPoint({ x: pos.x + width / 2, y: pos.y + height / 2 });
  const area = display.workArea;
  // Keep at least a third of the window on screen so the pet can never get lost.
  const minX = area.x - Math.floor((width * 2) / 3);
  const maxX = area.x + area.width - Math.floor(width / 3);
  const minY = area.y;
  const maxY = area.y + area.height - Math.floor(height / 3);
  return {
    x: Math.min(maxX, Math.max(minX, Math.round(pos.x))),
    y: Math.min(maxY, Math.max(minY, Math.round(pos.y))),
  };
}

export const RENDERER_DIR = (appPath: string) => join(appPath, "dist", "renderer");
