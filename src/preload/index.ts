// Exposes a small, typed API to the renderers. No Node access leaks into pages.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/types";
import type {
  Character,
  ChatStatusUpdate,
  ConnectionInfo,
  PetSnapshot,
  PetState,
  QuickChatResult,
  Settings,
} from "../shared/types";
import type { SettingsPatch } from "../main/settings-store";

type Listener<T> = (payload: T) => void;

function on<T>(channel: string, listener: Listener<T>): () => void {
  const wrapped = (_e: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),
    update: (patch: SettingsPatch): Promise<Settings> => ipcRenderer.invoke(IPC.updateSettings, patch),
    onChange: (l: Listener<Settings>) => on(IPC.settingsChanged, l),
  },
  characters: {
    list: (): Promise<Character[]> => ipcRenderer.invoke(IPC.getCharacters),
    add: (name: string, imagePath: string): Promise<Character> => ipcRenderer.invoke(IPC.addCharacter, name, imagePath),
    rename: (id: string, name: string): Promise<Character> => ipcRenderer.invoke(IPC.renameCharacter, id, name),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.deleteCharacter, id),
    duplicate: (id: string): Promise<Character> => ipcRenderer.invoke(IPC.duplicateCharacter, id),
    setAsset: (id: string, state: PetState, imagePath: string): Promise<Character> =>
      ipcRenderer.invoke(IPC.setCharacterAsset, id, state, imagePath),
    setAssetFromFile: async (id: string, state: PetState, file: File): Promise<Character> => {
      // Dropped files: prefer the real path (zero-copy), fall back to bytes.
      let path = "";
      try {
        path = webUtils.getPathForFile(file);
      } catch {
        path = "";
      }
      if (path) return ipcRenderer.invoke(IPC.setCharacterAsset, id, state, path);
      const bytes = new Uint8Array(await file.arrayBuffer());
      return ipcRenderer.invoke(IPC.setCharacterAssetFromPath, id, state, file.name, bytes);
    },
    clearAsset: (id: string, state: PetState): Promise<Character> => ipcRenderer.invoke(IPC.clearCharacterAsset, id, state),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke(IPC.revealCharacter, id),
    importFolder: (): Promise<Character | null> => ipcRenderer.invoke(IPC.importCharacterFolder),
    onChange: (l: Listener<Character[]>) => on(IPC.charactersChanged, l),
  },
  dialog: {
    pickImage: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickImage),
  },
  openclaw: {
    getConnection: (): Promise<ConnectionInfo> => ipcRenderer.invoke(IPC.getConnection),
    onConnection: (l: Listener<ConnectionInfo>) => on(IPC.connectionChanged, l),
    getSnapshot: (): Promise<PetSnapshot> => ipcRenderer.invoke(IPC.getSnapshot),
    onSnapshot: (l: Listener<PetSnapshot>) => on(IPC.snapshot, l),
    sendQuickChat: (text: string): Promise<QuickChatResult> => ipcRenderer.invoke(IPC.sendQuickChat, text),
    onChatStatus: (l: Listener<ChatStatusUpdate>) => on(IPC.chatStatus, l),
  },
  pet: {
    dragStart: (offsetX: number, offsetY: number): Promise<void> => ipcRenderer.invoke(IPC.dragStart, offsetX, offsetY),
    dragEnd: (): Promise<void> => ipcRenderer.invoke(IPC.dragEnd),
    setIgnoreMouse: (ignore: boolean): void => {
      ipcRenderer.send(IPC.setIgnoreMouse, ignore);
    },
    /** Content size (CSS px) the pet page needs; the main process grows/shrinks the window to fit. */
    setExtent: (width: number, height: number): Promise<void> => ipcRenderer.invoke(IPC.setExtent, width, height),
    onDropped: (l: Listener<{ dx: number; dy: number }>) => on(IPC.windowDropped, l),
    /** Dev-only: the main process asks the page to submit a quick-chat message (OPENCLAW_PET_TEST_MESSAGE). */
    onDebugSubmit: (l: Listener<string>) => on(IPC.debugSubmit, l),
  },
  app: {
    openSettings: (): Promise<void> => ipcRenderer.invoke(IPC.openSettings),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.quit),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
    platform: process.platform,
  },
};

export type PetApi = typeof api;

contextBridge.exposeInMainWorld("pet", api);
