// OpenClaw Pet — Electron main process.
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { IPC, type PetState, type Settings } from "../shared/types";
import { SettingsStore } from "./settings-store";
import { CharacterLibrary } from "./characters";
import { OpenClawController } from "./openclaw/controller";
import { loadOrCreateDeviceIdentity } from "./openclaw/device-identity";
import { PetTray } from "./tray";
import {
  applyAlwaysOnTop,
  clampToScreen,
  createPetWindow,
  createSettingsWindow,
  petWindowBounds,
} from "./windows";

const log = (msg: string) => {
  if (process.env.OPENCLAW_PET_DEBUG) console.log(`[pet] ${msg}`);
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    petWindow?.show();
    openSettings();
  });
  void main();
}

let petWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: PetTray | null = null;
let settingsStore: SettingsStore;
let characters: CharacterLibrary;
let controller: OpenClawController;
let dragTimer: NodeJS.Timeout | null = null;
let quitting = false;

const appPath = app.getAppPath();
const assetsDir = join(appPath, "assets");
const rendererDir = join(appPath, "dist", "renderer");
const preloadPath = join(appPath, "dist", "preload", "index.js");

async function main(): Promise<void> {
  app.setName("OpenClaw Pet");
  await app.whenReady();
  if (process.platform === "darwin") app.dock?.hide();

  const userData = app.getPath("userData");
  settingsStore = new SettingsStore(userData);
  characters = new CharacterLibrary(userData, join(assetsDir, "characters"));
  ensureCharacterExists();

  const identity = loadOrCreateDeviceIdentity(join(userData, "device-identity.json"));
  controller = new OpenClawController({
    identity,
    clientVersion: app.getVersion(),
    platform: process.platform,
    log,
  });
  controller.on("snapshot", (snap) => broadcast(IPC.snapshot, snap));
  controller.on("connection", (info) => {
    broadcast(IPC.connectionChanged, info);
    tray?.update({ connection: info });
  });
  controller.on("chatStatus", (update) => petWindow?.webContents.send(IPC.chatStatus, update));

  registerIpc();
  createPet();
  tray = new PetTray(assetsDir, {
    toggleOpenClaw: (enabled) => applySettings({ openclawEnabled: enabled }),
    togglePet: () => {
      if (!petWindow) return;
      if (petWindow.isVisible()) petWindow.hide();
      else petWindow.show();
      tray?.update({ petVisible: petWindow.isVisible() });
    },
    openSettings,
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  applyControllerSettings(settingsStore.get());
  applyLoginItem(settingsStore.get().launchAtLogin);
  tray.update({ enabled: settingsStore.get().openclawEnabled, connection: controller.getConnection() });
  scheduleDebugCapture();

  app.on("activate", () => petWindow?.show());
  app.on("before-quit", () => {
    quitting = true;
    controller.dispose();
  });
  app.on("window-all-closed", () => {
    // Tray app: keep running unless the user chose Quit.
    if (quitting) app.quit();
  });
}

function ensureCharacterExists(): void {
  const s = settingsStore.get();
  const all = characters.list();
  if (all.length === 0) return; // renderer shows a placeholder blob
  if (!all.some((c) => c.id === s.characterId)) settingsStore.update({ characterId: all[0].id });
}

function createPet(): void {
  const s = settingsStore.get();
  petWindow = createPetWindow({
    preload: preloadPath,
    html: join(rendererDir, "pet", "index.html"),
    size: s.size,
    alwaysOnTop: s.alwaysOnTop,
    position: s.position,
  });
  petWindow.on("closed", () => {
    petWindow = null;
  });
  petWindow.on("moved", () => {
    if (!petWindow || dragTimer) return;
    const [x, y] = petWindow.getPosition();
    settingsStore.update({ position: { x, y } });
  });
}

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = createSettingsWindow({
    preload: preloadPath,
    html: join(rendererDir, "settings", "index.html"),
    parentIcon: existsSync(join(assetsDir, "icon.png")) ? join(assetsDir, "icon.png") : undefined,
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function applyControllerSettings(s: Settings): void {
  controller.configure({
    enabled: s.openclawEnabled,
    gateway: s.gateway,
    reactionsEnabled: s.reactionsEnabled,
    reactionDurationMs: s.reactionDurationMs,
  });
}

function applyLoginItem(enabled: boolean): void {
  // macOS only accepts login items from a bundled .app; skip silently in `electron .` dev runs.
  if (!app.isPackaged) {
    log(`launch at login = ${enabled} (ignored in dev mode)`);
    return;
  }
  try {
    const current = app.getLoginItemSettings().openAtLogin;
    if (current !== enabled) app.setLoginItemSettings({ openAtLogin: enabled });
  } catch (err) {
    log(`setLoginItemSettings failed: ${(err as Error).message}`);
  }
}

/** Debug aid: OPENCLAW_PET_CAPTURE=/dir writes PNGs of both windows a few seconds after launch. */
function scheduleDebugCapture(): void {
  const dir = process.env.OPENCLAW_PET_CAPTURE;
  if (!dir) return;
  openSettings();
  setTimeout(async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    for (const [name, win] of [
      ["pet", petWindow],
      ["settings", settingsWindow],
    ] as const) {
      if (!win || win.isDestroyed()) continue;
      const image = await win.webContents.capturePage();
      writeFileSync(join(dir, `${name}.png`), image.toPNG());
      const state = await win.webContents.executeJavaScript("document.getElementById('stage')?.className ?? document.title").catch(() => "?");
      log(`captured ${name} → ${join(dir, `${name}.png`)} [${state}]`);
    }
  }, 5000);
}

function applySettings(patch: Partial<Settings>): Settings {
  const before = settingsStore.get();
  const next = settingsStore.update(patch);
  if (petWindow && (next.size !== before.size)) {
    const { width, height } = petWindowBounds(next.size);
    const [x, y] = petWindow.getPosition();
    const [w] = petWindow.getSize();
    // Keep the character horizontally centred where it was.
    const nx = x + Math.round((w - width) / 2);
    const pos = clampToScreen({ x: nx, y }, width, height) ?? { x: nx, y };
    petWindow.setBounds({ x: pos.x, y: pos.y, width, height });
  }
  if (petWindow && next.alwaysOnTop !== before.alwaysOnTop) applyAlwaysOnTop(petWindow, next.alwaysOnTop);
  if (next.launchAtLogin !== before.launchAtLogin) applyLoginItem(next.launchAtLogin);
  applyControllerSettings(next);
  tray?.update({ enabled: next.openclawEnabled });
  broadcast(IPC.settingsChanged, next);
  return next;
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settingsStore.get());
  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<Settings>) => applySettings(patch));

  ipcMain.handle(IPC.getCharacters, () => characters.list());
  ipcMain.handle(IPC.addCharacter, (_e, name: string, imagePath: string) => {
    const c = characters.add(name, imagePath);
    applySettings({ characterId: c.id });
    broadcast(IPC.charactersChanged, characters.list());
    return c;
  });
  ipcMain.handle(IPC.renameCharacter, (_e, id: string, name: string) => {
    const c = characters.rename(id, name);
    broadcast(IPC.charactersChanged, characters.list());
    return c;
  });
  ipcMain.handle(IPC.deleteCharacter, (_e, id: string) => {
    characters.delete(id);
    const remaining = characters.list();
    if (settingsStore.get().characterId === id) applySettings({ characterId: remaining[0]?.id ?? "" });
    broadcast(IPC.charactersChanged, remaining);
  });
  ipcMain.handle(IPC.duplicateCharacter, (_e, id: string) => {
    const c = characters.duplicate(id);
    broadcast(IPC.charactersChanged, characters.list());
    return c;
  });
  ipcMain.handle(IPC.setCharacterAsset, (_e, id: string, state: PetState, imagePath: string) => {
    const c = characters.setAsset(id, state, imagePath);
    broadcast(IPC.charactersChanged, characters.list());
    return c;
  });
  ipcMain.handle(IPC.setCharacterAssetFromPath, (_e, id: string, state: PetState, fileName: string, bytes: Uint8Array) => {
    const c = characters.setAssetFromBytes(id, state, fileName, bytes);
    broadcast(IPC.charactersChanged, characters.list());
    return c;
  });
  ipcMain.handle(IPC.clearCharacterAsset, (_e, id: string, state: PetState) => {
    const c = characters.clearAsset(id, state);
    broadcast(IPC.charactersChanged, characters.list());
    return c;
  });
  ipcMain.handle(IPC.revealCharacter, (_e, id: string) => {
    shell.showItemInFolder(join(characters.dir(id), "character.json"));
  });
  ipcMain.handle(IPC.importCharacterFolder, async () => {
    const res = await dialog.showOpenDialog(settingsWindow ?? undefined!, {
      title: "Import a character folder",
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const c = characters.importFolder(res.filePaths[0]);
    applySettings({ characterId: c.id });
    broadcast(IPC.charactersChanged, characters.list());
    return c;
  });
  ipcMain.handle(IPC.pickImage, async () => {
    const res = await dialog.showOpenDialog(settingsWindow ?? undefined!, {
      title: "Choose an image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "webp", "gif", "jpg", "jpeg", "svg", "apng", "avif"] }],
    });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.getConnection, () => controller.getConnection());
  ipcMain.handle(IPC.getSnapshot, () => controller.getSnapshot());
  ipcMain.handle(IPC.sendQuickChat, (_e, text: string) => controller.sendQuickChat(text));

  ipcMain.handle(IPC.dragStart, (_e, offsetX: number, offsetY: number) => {
    if (!petWindow) return;
    stopDrag();
    const win = petWindow;
    const start = win.getPosition();
    const startCursor = screen.getCursorScreenPoint();
    const scale = screen.getDisplayNearestPoint(startCursor).scaleFactor || 1;
    // offsetX/Y are CSS pixels inside the window; window positions are DIPs, so no scaling needed on either platform.
    void scale;
    dragTimer = setInterval(() => {
      if (win.isDestroyed()) return stopDrag();
      const cur = screen.getCursorScreenPoint();
      win.setPosition(Math.round(cur.x - offsetX), Math.round(cur.y - offsetY));
    }, 12);
    (dragTimer as any).__start = start;
  });
  ipcMain.handle(IPC.dragEnd, () => {
    const start = (dragTimer as any)?.__start as [number, number] | undefined;
    stopDrag();
    if (!petWindow) return;
    const [x, y] = petWindow.getPosition();
    const [w, h] = petWindow.getSize();
    const clamped = clampToScreen({ x, y }, w, h) ?? { x, y };
    if (clamped.x !== x || clamped.y !== y) petWindow.setPosition(clamped.x, clamped.y);
    settingsStore.update({ position: clamped });
    petWindow.webContents.send(IPC.windowDropped, { dx: clamped.x - (start?.[0] ?? x), dy: clamped.y - (start?.[1] ?? y) });
  });
  ipcMain.on(IPC.setIgnoreMouse, (_e, ignore: boolean) => {
    petWindow?.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.handle(IPC.openSettings, () => openSettings());
  ipcMain.handle(IPC.quit, () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

function stopDrag(): void {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
}
