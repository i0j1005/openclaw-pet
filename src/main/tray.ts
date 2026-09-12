// System tray / menu bar icon with the two-second-decision menu.
import { Menu, Tray, nativeImage, type NativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionInfo } from "../shared/types";

export interface TrayActions {
  toggleOpenClaw: (enabled: boolean) => void;
  togglePet: () => void;
  openSettings: () => void;
  quit: () => void;
}

export class PetTray {
  private tray: Tray;
  private connection: ConnectionInfo = { status: "off" };
  private enabled = true;
  private petVisible = true;

  constructor(private readonly assetsDir: string, private readonly actions: TrayActions) {
    this.tray = new Tray(this.icon());
    this.tray.setToolTip("OpenClaw Pet");
    this.rebuild();
    this.tray.on("click", () => {
      if (process.platform === "win32") this.tray.popUpContextMenu();
    });
  }

  update(params: { connection?: ConnectionInfo; enabled?: boolean; petVisible?: boolean }): void {
    if (params.connection) this.connection = params.connection;
    if (typeof params.enabled === "boolean") this.enabled = params.enabled;
    if (typeof params.petVisible === "boolean") this.petVisible = params.petVisible;
    this.rebuild();
  }

  destroy(): void {
    this.tray.destroy();
  }

  private statusLine(): string {
    switch (this.connection.status) {
      case "connected":
        return "OpenClaw: connected";
      case "connecting":
        return "OpenClaw: connecting…";
      case "reconnecting":
        return "OpenClaw: reconnecting…";
      case "error":
        return "OpenClaw: needs attention";
      default:
        return "OpenClaw: off";
    }
  }

  private rebuild(): void {
    const menu = Menu.buildFromTemplate([
      { label: this.statusLine(), enabled: false },
      ...(this.connection.status === "error" && this.connection.hint
        ? [{ label: wrap(this.connection.hint, 60), enabled: false }]
        : []),
      { type: "separator" },
      {
        label: "OpenClaw",
        type: "checkbox",
        checked: this.enabled,
        click: (item) => this.actions.toggleOpenClaw(item.checked),
      },
      { label: this.petVisible ? "Hide pet" : "Show pet", click: () => this.actions.togglePet() },
      { type: "separator" },
      { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => this.actions.openSettings() },
      { type: "separator" },
      { label: "Quit OpenClaw Pet", accelerator: "CmdOrCtrl+Q", click: () => this.actions.quit() },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(`OpenClaw Pet — ${this.statusLine()}`);
  }

  private icon(): NativeImage {
    const candidates =
      process.platform === "darwin"
        ? ["tray/trayTemplate.png"]
        : ["tray/tray.png", "tray/trayTemplate.png"];
    for (const rel of candidates) {
      const p = join(this.assetsDir, rel);
      if (existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (process.platform === "darwin") img.setTemplateImage(true);
        return img;
      }
    }
    return nativeImage.createEmpty();
  }
}

function wrap(text: string, width: number): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line = `${line} ${w}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}
