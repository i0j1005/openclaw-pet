// OpenClaw Pet — Electron main process.
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { IPC, type PetState, type Settings } from "../shared/types";
import { SettingsStore, type SettingsPatch } from "./settings-store";
import { CharacterLibrary } from "./characters";
import { OpenClawController } from "./openclaw/controller";
import { loadOrCreateDeviceIdentity } from "./openclaw/device-identity";
import { PetTray } from "./tray";
import {
  anchorFromWindow,
  applyAlwaysOnTop,
  clampToScreen,
  createPetWindow,
  createSettingsWindow,
  layoutPetWindow,
  petWindowBounds,
  type PetExtent,
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
/** Top-left of the base pet window (where the character is); the speech bubble may grow the window around it. */
let petAnchor: { x: number; y: number } = { x: 0, y: 0 };
let petExtent: PetExtent = { width: 0, height: 0 };
let lastProgrammaticPos: { x: number; y: number } | null = null;

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
  const [ax, ay] = petWindow.getPosition();
  petAnchor = { x: ax, y: ay };
  petWindow.on("closed", () => {
    petWindow = null;
  });
  petWindow.on("moved", () => {
    if (!petWindow || dragTimer) return;
    const [x, y] = petWindow.getPosition();
    // Moves we made ourselves (bubble growth / shrink) must not change the user's anchor.
    if (lastProgrammaticPos && lastProgrammaticPos.x === x && lastProgrammaticPos.y === y) return;
    petAnchor = anchorFromWindow({ x, y }, settingsStore.get().size, petExtent);
    settingsStore.update({ position: petAnchor });
  });
}

/** Re-applies the pet window bounds from the anchor, the character size and the renderer's extent. */
function layoutPet(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = layoutPetWindow(petAnchor, settingsStore.get().size, petExtent);
  const [cx, cy] = petWindow.getPosition();
  const [cw, ch] = petWindow.getSize();
  if (cx === bounds.x && cy === bounds.y && cw === bounds.width && ch === bounds.height) return;
  lastProgrammaticPos = { x: bounds.x, y: bounds.y };
  petWindow.setBounds(bounds);
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
    reactionHoldMs: s.reactionHoldMs,
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

/**
 * Debug aid (dev runs only, see scripts/dev-run.mjs):
 *   OPENCLAW_PET_CAPTURE=/dir            writes PNGs of both windows 5 s after launch
 *   OPENCLAW_PET_CAPTURE_SHOTS=N         then keeps capturing the pet every 3 s, N times (pet-1.png, pet-2.png…)
 *   OPENCLAW_PET_TEST_MESSAGE="text"     submits one quick-chat message through the renderer 4 s after launch.
 *                                        This starts ONE real agent turn; it is opt-in and never set in normal use.
 */
function scheduleDebugCapture(): void {
  const dir = process.env.OPENCLAW_PET_CAPTURE;
  const testMessage = process.env.OPENCLAW_PET_TEST_MESSAGE;
  if (!dir && !testMessage) return;
  if (testMessage) {
    setTimeout(() => {
      log(`debug: submitting test quick-chat message through the pet window`);
      petWindow?.webContents.send(IPC.debugSubmit, testMessage);
    }, 4000);
  }
  if (!dir) return;
  openSettings();
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dir, { recursive: true });
  const describe = (win: BrowserWindow) =>
    win.webContents
      .executeJavaScript(
        "(() => { const s = document.getElementById('stage'); const b = document.getElementById('bubble'); return (s?.className ?? document.title) + (b && !b.hidden ? ' | bubble: ' + (b.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160) : ''); })()",
      )
      .catch(() => "?");
  const snap = async (name: string, win: BrowserWindow | null) => {
    if (!win || win.isDestroyed()) return;
    const image = await win.webContents.capturePage();
    writeFileSync(join(dir, `${name}.png`), image.toPNG());
    const [w, h] = win.getSize();
    log(`captured ${name} → ${join(dir, `${name}.png`)} ${w}x${h} [${await describe(win)}]`);
  };
  const scrollSettingsTo = async (selector: string) => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    await settingsWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" })`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
  };
  // OPENCLAW_PET_CAPTURE_EVAL / _EVAL_END: JS run in the pet page before the first / after the last shot.
  const evalInPet = async (label: string, code: string | undefined) => {
    if (!code || !petWindow || petWindow.isDestroyed()) return;
    const r = await petWindow.webContents.executeJavaScript(code).catch((e) => `error: ${e}`);
    log(`debug eval (${label}): ${typeof r === "string" ? r : JSON.stringify(r)}`);
  };
  setTimeout(async () => {
    await evalInPet("start", process.env.OPENCLAW_PET_CAPTURE_EVAL);
    await snap("pet", petWindow);
    await snap("settings", settingsWindow);
    await scrollSettingsTo("#assets");
    await snap("settings-assets", settingsWindow);
    await scrollSettingsTo("#ambientRows");
    await snap("settings-behavior", settingsWindow);
    const shots = Number(process.env.OPENCLAW_PET_CAPTURE_SHOTS ?? "0");
    const collapseAt = Number(process.env.OPENCLAW_PET_CAPTURE_COLLAPSE_AT ?? "0");
    for (let i = 1; i <= shots; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      if (i === collapseAt && petWindow && !petWindow.isDestroyed()) {
        // Simulate a click on the bubble (mousedown + click, no movement) to toggle the pill.
        await petWindow.webContents
          .executeJavaScript(
            "(() => { const b = document.getElementById('bubble'); if (!b || b.hidden) return 'no bubble'; for (const t of ['mousedown','click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: 10, clientY: 10, button: 0 })); return b.className; })()",
          )
          .then((r) => log(`debug: toggled bubble → ${r}`))
          .catch((e) => log(`debug: toggle failed ${e}`));
        await new Promise((r) => setTimeout(r, 400));
      }
      await snap(`pet-${i}`, petWindow);
    }
    await evalInPet("end", process.env.OPENCLAW_PET_CAPTURE_EVAL_END);
  }, 5000);
}

function applySettings(patch: SettingsPatch): Settings {
  const before = settingsStore.get();
  const next = settingsStore.update(patch);
  if (petWindow && next.size !== before.size) {
    // Keep the character horizontally centred where it was.
    const oldW = petWindowBounds(before.size).width;
    const { width, height } = petWindowBounds(next.size);
    const nx = petAnchor.x + Math.round((oldW - width) / 2);
    petAnchor = clampToScreen({ x: nx, y: petAnchor.y }, width, height) ?? { x: nx, y: petAnchor.y };
    settingsStore.update({ position: petAnchor });
    layoutPet();
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
  ipcMain.handle(IPC.updateSettings, (_e, patch: SettingsPatch) => applySettings(patch));

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
  ipcMain.handle(IPC.sendQuickChat, (_e, text: string) => {
    if (process.env.OPENCLAW_PET_TEST_DRY) return fakeQuickChat(text);
    return controller.sendQuickChat(text);
  });

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
    if (clamped.x !== x || clamped.y !== y) {
      lastProgrammaticPos = clamped;
      petWindow.setPosition(clamped.x, clamped.y);
    }
    // Wherever the user dropped it is the new anchor, even if the window is currently grown by the bubble.
    petAnchor = anchorFromWindow(clamped, settingsStore.get().size, petExtent);
    settingsStore.update({ position: petAnchor });
    petWindow.webContents.send(IPC.windowDropped, { dx: clamped.x - (start?.[0] ?? x), dy: clamped.y - (start?.[1] ?? y) });
  });
  ipcMain.on(IPC.setIgnoreMouse, (_e, ignore: boolean) => {
    petWindow?.setIgnoreMouseEvents(ignore, { forward: true });
  });
  ipcMain.handle(IPC.setExtent, (_e, width: number, height: number) => {
    const next = { width: Math.max(0, Number(width) || 0), height: Math.max(0, Number(height) || 0) };
    if (next.width === petExtent.width && next.height === petExtent.height) return;
    petExtent = next;
    layoutPet();
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

/**
 * Dev-only stand-in for chat.send (OPENCLAW_PET_TEST_DRY=1): plays the same chat status sequence the
 * gateway would produce, without any network or tokens, so the bubble/window logic can be exercised.
 */
function fakeQuickChat(text: string): { ok: boolean; runId: string } {
  const runId = `dry-${Date.now()}`;
  const send = (update: unknown) => petWindow?.webContents.send(IPC.chatStatus, update);
  log(`dry run: pretending to send "${text}"`);
  setTimeout(() => send({ runId, phase: "sent" }), 100);
  setTimeout(() => send({ runId, phase: "working" }), 1500);
  setTimeout(() => send({ runId, phase: "thinking", text: "Sure! Here is a longer sample reply so the bubble has something to" }), 3000);
  setTimeout(
    () =>
      send({
        runId,
        phase: "reply",
        text:
          "Sure! Here is a longer sample reply so the bubble has something to show: the three points are tabs, spaces, and the fact that people will argue about them forever. Anyway, all done ✅",
      }),
    4500,
  );
  return { ok: true, runId };
}

function stopDrag(): void {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
}
