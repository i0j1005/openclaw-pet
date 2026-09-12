// Settings window renderer.
import {
  PET_STATES,
  STATE_FALLBACKS,
  STATE_HINTS,
  STATE_LABELS,
  type Character,
  type ConnectionInfo,
  type PetState,
  type Settings,
} from "../../shared/types";

const api = window.pet;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let characters: Character[] = [];

// ---- helpers --------------------------------------------------------------------

function toast(text: string, ms = 2600): void {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  window.setTimeout(() => (t.hidden = true), ms);
}

function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized).replace(/#/g, "%23")}?v=${Date.now()}`;
}

function current(): Character | undefined {
  return characters.find((c) => c.id === settings.characterId) ?? characters[0];
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await api.settings.update(patch);
  renderSettings();
}

function bindSwitch(id: keyof Settings): void {
  const el = $<HTMLInputElement>(id);
  el.addEventListener("change", () => void save({ [id]: el.checked } as Partial<Settings>));
}

// ---- rendering ------------------------------------------------------------------

function renderSettings(): void {
  $<HTMLInputElement>("openclawEnabled").checked = settings.openclawEnabled;
  $<HTMLInputElement>("launchAtLogin").checked = settings.launchAtLogin;
  $<HTMLInputElement>("alwaysOnTop").checked = settings.alwaysOnTop;
  $<HTMLInputElement>("reactionsEnabled").checked = settings.reactionsEnabled;
  $<HTMLInputElement>("hoverChatEnabled").checked = settings.hoverChatEnabled;
  $<HTMLInputElement>("size").value = String(settings.size);
  $("sizeLabel").textContent = `${settings.size} px`;
  $<HTMLInputElement>("reactionDuration").value = String(Math.round(settings.reactionDurationMs / 1000));
  $("reactionLabel").textContent = `${Math.round(settings.reactionDurationMs / 1000)} s`;
  $<HTMLSelectElement>("gwMode").value = settings.gateway.mode;
  $<HTMLInputElement>("gwUrl").value = settings.gateway.url ?? "";
  $<HTMLInputElement>("gwToken").value = settings.gateway.token ?? "";
  $<HTMLInputElement>("gwPassword").value = settings.gateway.password ?? "";
  $<HTMLInputElement>("gwUrl").disabled = settings.gateway.mode !== "manual";
  renderCharacterSelect();
  renderAssets();
}

function renderConnection(info: ConnectionInfo): void {
  const badge = $("connBadge");
  badge.className = `conn conn-${info.status}`;
  const text: Record<ConnectionInfo["status"], string> = {
    off: "OpenClaw off",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    connected: "Connected to OpenClaw",
    error: "Needs attention",
  };
  $("connText").textContent = text[info.status];
  const hint = $("connHint");
  if (info.status === "error" && info.hint) {
    hint.hidden = false;
    $("connHintText").textContent = info.hint;
    $("connDetail").textContent = [info.gatewayUrl ? `gateway: ${info.gatewayUrl}` : "", info.detail ?? ""].filter(Boolean).join("\n");
    if (/token/i.test(info.hint)) ($("advanced") as HTMLDetailsElement).open = true;
  } else hint.hidden = true;
  const target = $("connTarget");
  if (info.status === "connected" && info.targetSession) {
    target.hidden = false;
    target.textContent = `Quick chat continues: ${info.targetSession.label}${info.targetSession.agentId ? ` (agent ${info.targetSession.agentId})` : ""}`;
  } else target.hidden = true;
}

function renderCharacterSelect(): void {
  const select = $<HTMLSelectElement>("characterSelect");
  select.innerHTML = "";
  for (const c of characters) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  }
  const cur = current();
  if (cur) select.value = cur.id;
  const none = characters.length === 0;
  for (const id of ["renameBtn", "duplicateBtn", "deleteBtn", "revealBtn"]) ($(id) as HTMLButtonElement).disabled = none;
  ($("deleteBtn") as HTMLButtonElement).disabled = none || characters.length === 1;
}

function renderAssets(): void {
  const container = $("assets");
  container.innerHTML = "";
  const c = current();
  if (!c) {
    container.innerHTML = `<div class="muted">No character yet. Click <b>Add Character</b> to create one from a single image.</div>`;
    return;
  }
  for (const state of PET_STATES) {
    const row = document.createElement("div");
    row.className = "asset";
    row.dataset.state = state;
    const own = c.assets[state];
    const fb = own ? null : STATE_FALLBACKS[state].find((s) => c.assets[s]);
    const shown = own ?? (fb ? c.assets[fb] : undefined);
    row.innerHTML = `
      <div class="thumb ${shown ? "" : "empty"}">${shown ? `<img alt="" src="${fileUrl(shown)}">` : "none"}</div>
      <div>
        <div class="name">${STATE_LABELS[state]}${state === "idle" ? " <span class='muted'>(required)</span>" : ""}</div>
        <div class="muted">${STATE_HINTS[state]}</div>
        ${!own && fb ? `<div class="fallback">Using the ${STATE_LABELS[fb]} image</div>` : ""}
      </div>
      <div class="actions">
        <button class="small change">Change…</button>
        <button class="small clear" ${own && state !== "idle" ? "" : "disabled"}>Clear</button>
      </div>`;
    row.querySelector<HTMLButtonElement>(".change")!.addEventListener("click", async () => {
      const path = await api.dialog.pickImage();
      if (!path) return;
      await guard(() => api.characters.setAsset(c.id, state, path), `${STATE_LABELS[state]} image updated`);
    });
    row.querySelector<HTMLButtonElement>(".clear")!.addEventListener("click", async () => {
      await guard(() => api.characters.clearAsset(c.id, state), `${STATE_LABELS[state]} image cleared`);
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("dragover");
    });
    row.addEventListener("dragleave", () => row.classList.remove("dragover"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("dragover");
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      await guard(() => api.characters.setAssetFromFile(c.id, state, file), `${STATE_LABELS[state]} image updated`);
    });
    container.appendChild(row);
  }
}

async function guard<T>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (okMessage) toast(okMessage);
    return r;
  } catch (err) {
    toast((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), 4500);
    return undefined;
  }
}

// ---- wiring ----------------------------------------------------------------------

bindSwitch("openclawEnabled");
bindSwitch("launchAtLogin");
bindSwitch("alwaysOnTop");
bindSwitch("reactionsEnabled");
bindSwitch("hoverChatEnabled");

const sizeInput = $<HTMLInputElement>("size");
sizeInput.addEventListener("input", () => ($("sizeLabel").textContent = `${sizeInput.value} px`));
sizeInput.addEventListener("change", () => void save({ size: Number(sizeInput.value) }));

const reactionInput = $<HTMLInputElement>("reactionDuration");
reactionInput.addEventListener("input", () => ($("reactionLabel").textContent = `${reactionInput.value} s`));
reactionInput.addEventListener("change", () => void save({ reactionDurationMs: Number(reactionInput.value) * 1000 }));

$<HTMLSelectElement>("characterSelect").addEventListener("change", (e) => {
  void save({ characterId: (e.target as HTMLSelectElement).value });
});

// Add character flow: name → image → done.
let pickedImage: string | null = null;
$("addBtn").addEventListener("click", () => {
  $("addForm").hidden = false;
  $<HTMLInputElement>("addName").focus();
});
$("addCancel").addEventListener("click", () => {
  $("addForm").hidden = true;
  pickedImage = null;
  $("addPicked").textContent = "";
  ($("addConfirm") as HTMLButtonElement).disabled = true;
});
$("addPick").addEventListener("click", async () => {
  pickedImage = await api.dialog.pickImage();
  $("addPicked").textContent = pickedImage ? pickedImage.split(/[\\/]/).pop() ?? "" : "";
  ($("addConfirm") as HTMLButtonElement).disabled = !pickedImage;
});
$("addConfirm").addEventListener("click", async () => {
  const name = $<HTMLInputElement>("addName").value.trim() || "Character";
  if (!pickedImage) return;
  const c = await guard(() => api.characters.add(name, pickedImage!), `${name} added`);
  if (c) {
    $("addForm").hidden = true;
    $<HTMLInputElement>("addName").value = "";
    pickedImage = null;
    $("addPicked").textContent = "";
    ($("addConfirm") as HTMLButtonElement).disabled = true;
  }
});

$("renameBtn").addEventListener("click", async () => {
  const c = current();
  if (!c) return;
  const name = window.prompt("New name", c.name);
  if (name && name.trim()) await guard(() => api.characters.rename(c.id, name.trim()), "Renamed");
});
$("duplicateBtn").addEventListener("click", async () => {
  const c = current();
  if (!c) return;
  const copy = await guard(() => api.characters.duplicate(c.id), "Duplicated");
  if (copy) await save({ characterId: copy.id });
});
$("deleteBtn").addEventListener("click", async () => {
  const c = current();
  if (!c) return;
  if (!window.confirm(`Delete "${c.name}" and its images? This cannot be undone.`)) return;
  await guard(() => api.characters.delete(c.id), "Deleted");
});
$("importBtn").addEventListener("click", async () => {
  const c = await guard(() => api.characters.importFolder());
  if (c) toast(`${c.name} imported`);
});
$("revealBtn").addEventListener("click", () => {
  const c = current();
  if (c) void api.characters.reveal(c.id);
});

$<HTMLSelectElement>("gwMode").addEventListener("change", (e) => {
  $<HTMLInputElement>("gwUrl").disabled = (e.target as HTMLSelectElement).value !== "manual";
});
$("gwSave").addEventListener("click", async () => {
  await save({
    gateway: {
      mode: $<HTMLSelectElement>("gwMode").value as "auto" | "manual",
      url: $<HTMLInputElement>("gwUrl").value.trim() || undefined,
      token: $<HTMLInputElement>("gwToken").value.trim() || undefined,
      password: $<HTMLInputElement>("gwPassword").value.trim() || undefined,
    },
    openclawEnabled: true,
  });
  toast("Saved. Reconnecting…");
});
$("quitBtn").addEventListener("click", () => void api.app.quit());

api.settings.onChange((s) => {
  settings = s;
  renderSettings();
});
api.characters.onChange((all) => {
  characters = all;
  renderCharacterSelect();
  renderAssets();
});
api.openclaw.onConnection(renderConnection);

(async () => {
  settings = await api.settings.get();
  characters = await api.characters.list();
  renderSettings();
  renderConnection(await api.openclaw.getConnection());
})();
