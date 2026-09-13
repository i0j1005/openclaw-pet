// Settings window renderer.
import {
  AMBIENT_LIMITS,
  AMBIENT_STATES,
  DEFAULT_SETTINGS,
  HOLD_LIMITS,
  PET_STATES,
  REACTION_STATES,
  STATE_FALLBACKS,
  STATE_HINTS,
  STATE_LABELS,
  type AgentOption,
  type AmbientState,
  type Character,
  type ConnectionInfo,
  type PetState,
  type ReactionKind,
  type Settings,
} from "../../shared/types";
import type { SettingsPatch } from "../../main/settings-store";

const api = window.pet;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let characters: Character[] = [];
/** Agent roster from the gateway; null until fetched (or while OpenClaw is off). */
let agents: AgentOption[] | null = null;
let connected = false;

// ---- helpers --------------------------------------------------------------------

function toast(text: string, ms = 2600): void {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  window.setTimeout(() => (t.hidden = true), ms);
}

function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  // CharacterLibrary gives every newly added asset a unique file name, so the path itself is a
  // reliable cache key. A timestamp here made every unrelated settings change reload and decode
  // every thumbnail in the character library.
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function current(): Character | undefined {
  return characters.find((c) => c.id === settings.characterId) ?? characters[0];
}

async function save(patch: SettingsPatch): Promise<void> {
  // The main process broadcasts the normalized value back through settings.onChange. Rendering
  // here as well rebuilt the full settings page twice for every click.
  await api.settings.update(patch);
}

function bindSwitch(id: keyof Settings): void {
  const el = $<HTMLInputElement>(id);
  el.addEventListener("change", () => void save({ [id]: el.checked } as SettingsPatch));
}

// ---- rendering ------------------------------------------------------------------

function renderSettings(renderCharacter = true): void {
  $<HTMLInputElement>("openclawEnabled").checked = settings.openclawEnabled;
  $<HTMLInputElement>("launchAtLogin").checked = settings.launchAtLogin;
  $<HTMLInputElement>("alwaysOnTop").checked = settings.alwaysOnTop;
  $<HTMLInputElement>("reactionsEnabled").checked = settings.reactionsEnabled;
  $<HTMLInputElement>("hoverChatEnabled").checked = settings.hoverChatEnabled;
  $<HTMLInputElement>("size").value = String(settings.size);
  $("sizeLabel").textContent = `${settings.size} px`;
  if ($<HTMLDetailsElement>("behaviorPanel").open && $<HTMLDetailsElement>("ambientPanel").open) renderAmbientRows();
  if ($<HTMLDetailsElement>("behaviorPanel").open && $<HTMLDetailsElement>("reactionLengthPanel").open) renderHoldRows();
  $<HTMLSelectElement>("gwMode").value = settings.gateway.mode;
  $<HTMLInputElement>("gwUrl").value = settings.gateway.url ?? "";
  $<HTMLInputElement>("gwToken").value = settings.gateway.token ?? "";
  $<HTMLInputElement>("gwPassword").value = settings.gateway.password ?? "";
  $<HTMLInputElement>("gwUrl").disabled = settings.gateway.mode !== "manual";
  // Character controls and thumbnails only depend on characterId. Avoid rebuilding them for an
  // unrelated toggle, duration, bubble-size, or connection setting.
  if (renderCharacter) {
    renderCharacterSelect();
    renderAssets();
  }
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
  const wasConnected = connected;
  connected = info.status === "connected";
  if (connected && (!wasConnected || agents === null)) void refreshAgents();
  else if (!connected && wasConnected) renderAgentSelects();
}

// ---- agents ----------------------------------------------------------------------

async function refreshAgents(): Promise<void> {
  const list = await api.openclaw.listAgents();
  agents = list;
  renderAgentSelects();
}

const ANY_AGENT = "";

/** Options for an agent picker: "Any", the roster, and the bound id even if it is not (yet) in the roster. */
function fillAgentSelect(select: HTMLSelectElement, selected: string | undefined): void {
  select.innerHTML = "";
  const any = document.createElement("option");
  any.value = ANY_AGENT;
  any.textContent = "Any agent (most recent session)";
  select.appendChild(any);
  const known = new Set<string>();
  for (const a of agents ?? []) {
    known.add(a.id);
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.emoji ? `${a.emoji} ` : ""}${a.name}${a.name !== a.id ? ` (${a.id})` : ""}${a.isDefault ? " · default" : ""}`;
    select.appendChild(opt);
  }
  if (selected && !known.has(selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = `${selected}${connected ? " (not in the agent list)" : ""}`;
    select.appendChild(opt);
  }
  select.value = selected ?? ANY_AGENT;
}

function renderAgentSelects(): void {
  const c = current();
  const select = $<HTMLSelectElement>("agentSelect");
  fillAgentSelect(select, c?.agentId);
  select.disabled = !c;
  const hint = $("agentHint");
  if (!connected && !agents?.length) hint.textContent = "Connect OpenClaw to choose an agent.";
  else if (c?.agentId) hint.textContent = `Uses ${c.agentId}'s recent conversation.`;
  else hint.textContent = "Uses the most recent conversation.";
  const addSelect = $<HTMLSelectElement>("addAgent");
  fillAgentSelect(addSelect, addSelect.value || undefined);
  renderAgentAssignments();
}

/** Agent-first view of the same one-to-one bindings stored in each character manifest. */
function renderAgentAssignments(): void {
  if (!$<HTMLDetailsElement>("agentAssignmentsPanel").open) return;
  const container = $("agentAssignments");
  container.innerHTML = "";
  const options = new Map<string, AgentOption>();
  for (const agent of agents ?? []) options.set(agent.id, agent);
  for (const c of characters) {
    if (c.agentId && !options.has(c.agentId)) options.set(c.agentId, { id: c.agentId, name: c.agentId });
  }
  if (!options.size) {
    const empty = document.createElement("div");
    empty.className = "assignment-empty";
    empty.textContent = connected
      ? "No configurable agents were returned by OpenClaw."
      : "Connect OpenClaw to discover agents. Saved assignments will still appear here.";
    container.appendChild(empty);
    return;
  }

  for (const agent of options.values()) {
    const assigned = characters.find((c) => c.agentId === agent.id);
    const row = document.createElement("div");
    row.className = "assignment-row";
    const identity = document.createElement("div");
    identity.className = "assignment-agent";
    const name = document.createElement("strong");
    name.textContent = `${agent.emoji ? `${agent.emoji} ` : ""}${agent.name}${agent.isDefault ? " · default" : ""}`;
    const id = document.createElement("span");
    id.textContent = agent.id;
    identity.append(name, id);

    const select = document.createElement("select");
    select.setAttribute("aria-label", `Character for ${agent.name}`);
    const unassigned = document.createElement("option");
    unassigned.value = "";
    unassigned.textContent = "No character assigned";
    select.appendChild(unassigned);
    for (const c of characters) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.agentId && c.agentId !== agent.id ? `${c.name} · currently ${c.agentId}` : c.name;
      select.appendChild(opt);
    }
    select.value = assigned?.id ?? "";
    select.disabled = characters.length === 0;
    const choice = document.createElement("div");
    choice.className = "assignment-choice";
    const preview = document.createElement("img");
    preview.alt = "";
    const renderPreview = (characterId: string) => {
      const src = characters.find((c) => c.id === characterId)?.assets.idle?.[0];
      if (src) {
        preview.src = fileUrl(src);
        preview.hidden = false;
      } else {
        preview.removeAttribute("src");
        preview.hidden = true;
      }
    };
    renderPreview(select.value);
    select.addEventListener("change", async () => {
      select.disabled = true;
      const characterId = select.value;
      renderPreview(characterId);
      if (characterId) {
        const c = characters.find((item) => item.id === characterId);
        await guard(() => api.characters.setAgent(characterId, agent.id), `${agent.name} now uses ${c?.name ?? characterId}`);
      } else if (assigned) {
        await guard(() => api.characters.setAgent(assigned.id, null), `${agent.name} is no longer assigned`);
      }
      select.disabled = false;
    });
    choice.append(preview, select);
    row.append(identity, choice);
    container.appendChild(row);
  }
}

// Per-state ambient motion rows are built once; afterwards only their values are refreshed so a
// slider being dragged is never re-created under the cursor.
const AMBIENT_HINTS: Record<AmbientState, string> = {
  idle: "breathing",
  thinking: "swaying",
  working: "bouncing",
  question: "head tilt",
};

function renderAmbientRows(): void {
  const container = $("ambientRows");
  if (!container.childElementCount) {
    for (const state of AMBIENT_STATES) {
      const row = document.createElement("div");
      row.className = "mrow";
      row.dataset.state = state;
      row.innerHTML = `
        <div><div class="name">${STATE_LABELS[state]}</div><div class="muted">${AMBIENT_HINTS[state]}</div></div>
        <label class="switch"><input type="checkbox" class="on" /><span></span></label>
        <label class="knob">Intensity <input type="range" class="intensity" min="${AMBIENT_LIMITS.intensity.min}" max="${AMBIENT_LIMITS.intensity.max}" step="0.1" /><span class="val i"></span></label>
        <label class="knob">Speed <input type="range" class="speed" min="${AMBIENT_LIMITS.speed.min}" max="${AMBIENT_LIMITS.speed.max}" step="0.05" /><span class="val s"></span></label>`;
      const on = row.querySelector<HTMLInputElement>(".on")!;
      const intensity = row.querySelector<HTMLInputElement>(".intensity")!;
      const speed = row.querySelector<HTMLInputElement>(".speed")!;
      on.addEventListener("change", () => void save({ ambientMotion: { [state]: { enabled: on.checked } } }));
      intensity.addEventListener("input", () => (row.querySelector(".val.i")!.textContent = `${Math.round(Number(intensity.value) * 100)}%`));
      intensity.addEventListener("change", () => void save({ ambientMotion: { [state]: { intensity: Number(intensity.value) } } }));
      speed.addEventListener("input", () => (row.querySelector(".val.s")!.textContent = `${Number(speed.value).toFixed(2)}×`));
      speed.addEventListener("change", () => void save({ ambientMotion: { [state]: { speed: Number(speed.value) } } }));
      container.appendChild(row);
    }
  }
  for (const row of container.querySelectorAll<HTMLElement>(".mrow")) {
    const m = settings.ambientMotion[row.dataset.state as AmbientState];
    row.classList.toggle("off", !m.enabled);
    row.querySelector<HTMLInputElement>(".on")!.checked = m.enabled;
    row.querySelector<HTMLInputElement>(".intensity")!.value = String(m.intensity);
    row.querySelector(".val.i")!.textContent = `${Math.round(m.intensity * 100)}%`;
    row.querySelector<HTMLInputElement>(".speed")!.value = String(m.speed);
    row.querySelector(".val.s")!.textContent = `${m.speed.toFixed(2)}×`;
  }
}

function renderHoldRows(): void {
  const container = $("holdRows");
  if (!container.childElementCount) {
    for (const r of REACTION_STATES) {
      const row = document.createElement("div");
      row.className = "mrow hrow";
      row.dataset.reaction = r;
      row.innerHTML = `
        <div class="name">${STATE_LABELS[r]}</div>
        <label class="knob"><input type="range" class="hold" min="${HOLD_LIMITS.min / 1000}" max="30" step="1" /><span class="val h"></span></label>
        <span class="mhint">${STATE_HINTS[r]}</span>`;
      const hold = row.querySelector<HTMLInputElement>(".hold")!;
      hold.addEventListener("input", () => (row.querySelector(".val.h")!.textContent = `${hold.value} s`));
      hold.addEventListener("change", () => void save({ reactionHoldMs: { [r]: Number(hold.value) * 1000 } }));
      container.appendChild(row);
    }
  }
  for (const row of container.querySelectorAll<HTMLElement>(".hrow")) {
    const r = row.dataset.reaction as ReactionKind;
    const s = Math.round(settings.reactionHoldMs[r] / 1000);
    row.querySelector<HTMLInputElement>(".hold")!.value = String(s);
    row.querySelector(".val.h")!.textContent = `${s} s`;
  }
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
  renderAgentSelects();
}

/**
 * One row per state: every variant as a thumbnail with its own remove button, an "Add" tile, and
 * drag-and-drop that appends (drop several files at once to add several variants).
 */
function renderAssets(): void {
  if (!$<HTMLDetailsElement>("assetsPanel").open) return;
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
    const own = c.assets[state] ?? [];
    const fb = own.length ? null : STATE_FALLBACKS[state].find((s) => c.assets[s]?.length);
    const canRemove = state !== "idle" || own.length > 1;
    row.innerHTML = `
      <div class="asset-head">
        <div class="name">${STATE_LABELS[state]}${state === "idle" ? " <span class='muted'>(required)</span>" : ""}</div>
        <div class="muted">${STATE_HINTS[state]}</div>
        ${own.length > 1 ? `<div class="count">${own.length} images, one picked at random</div>` : ""}
        ${!own.length && fb ? `<div class="fallback">Using the ${STATE_LABELS[fb]} image${(c.assets[fb]?.length ?? 0) > 1 ? "s" : ""}</div>` : ""}
      </div>
      <div class="variants">
        ${own
          .map(
            (p, i) => `
          <div class="variant" title="${escapeAttr(p.split(/[\\/]/).pop() ?? "")}">
            <img alt="" loading="lazy" decoding="async" src="${fileUrl(p)}">
            <button class="remove" data-index="${i}" title="Remove this image" aria-label="Remove ${STATE_LABELS[state]} image ${i + 1}" ${canRemove ? "" : "disabled"}>×</button>
          </div>`,
          )
          .join("")}
        ${!own.length && fb ? `<div class="variant ghost" title="Fallback"><img alt="" loading="lazy" decoding="async" src="${fileUrl(c.assets[fb]![0])}"></div>` : ""}
        <button class="variant add" title="Add an image (or drop files on this row)">＋<span>Add</span></button>
      </div>`;
    row.querySelector<HTMLButtonElement>(".add")!.addEventListener("click", async () => {
      const path = await api.dialog.pickImage();
      if (!path) return;
      await guard(() => api.characters.addAssetVariant(c.id, state, path), `${STATE_LABELS[state]}: image added`);
    });
    for (const btn of row.querySelectorAll<HTMLButtonElement>(".remove")) {
      btn.addEventListener("click", async () => {
        const index = Number(btn.dataset.index);
        await guard(() => api.characters.removeAssetVariant(c.id, state, index), `${STATE_LABELS[state]}: image removed`);
      });
    }
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("dragover");
    });
    row.addEventListener("dragleave", () => row.classList.remove("dragover"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("dragover");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      let added = 0;
      for (const file of files) {
        const r = await guard(() => api.characters.addAssetVariantFromFile(c.id, state, file));
        if (r) added += 1;
      }
      if (added) toast(`${STATE_LABELS[state]}: ${added} image${added === 1 ? "" : "s"} added`);
    });
    container.appendChild(row);
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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

$<HTMLDetailsElement>("assetsPanel").addEventListener("toggle", (event) => {
  if ((event.currentTarget as HTMLDetailsElement).open) renderAssets();
});
$<HTMLDetailsElement>("agentAssignmentsPanel").addEventListener("toggle", (event) => {
  if ((event.currentTarget as HTMLDetailsElement).open) renderAgentAssignments();
});
$<HTMLDetailsElement>("behaviorPanel").addEventListener("toggle", (event) => {
  if (!(event.currentTarget as HTMLDetailsElement).open) return;
  if ($<HTMLDetailsElement>("ambientPanel").open) renderAmbientRows();
  if ($<HTMLDetailsElement>("reactionLengthPanel").open) renderHoldRows();
});
$<HTMLDetailsElement>("ambientPanel").addEventListener("toggle", (event) => {
  if ((event.currentTarget as HTMLDetailsElement).open) renderAmbientRows();
});
$<HTMLDetailsElement>("reactionLengthPanel").addEventListener("toggle", (event) => {
  if ((event.currentTarget as HTMLDetailsElement).open) renderHoldRows();
});

const sizeInput = $<HTMLInputElement>("size");
sizeInput.addEventListener("input", () => ($("sizeLabel").textContent = `${sizeInput.value} px`));
sizeInput.addEventListener("change", () => void save({ size: Number(sizeInput.value) }));

$("bubbleReset").addEventListener("click", async () => {
  await save({ bubble: { ...DEFAULT_SETTINGS.bubble, collapsed: false } });
  toast("Bubble size reset");
});

$<HTMLSelectElement>("characterSelect").addEventListener("change", (e) => {
  void save({ characterId: (e.target as HTMLSelectElement).value });
});
$<HTMLSelectElement>("agentSelect").addEventListener("change", async (e) => {
  const c = current();
  if (!c) return;
  const agentId = (e.target as HTMLSelectElement).value || null;
  await guard(() => api.characters.setAgent(c.id, agentId), agentId ? `${c.name} now talks to ${agentId}` : `${c.name} follows the most recent session`);
});

// Add character flow: name → image → (agent) → done.
let pickedImage: string | null = null;
$("addBtn").addEventListener("click", () => {
  $("addForm").hidden = false;
  if (connected) void refreshAgents();
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
  const agentId = $<HTMLSelectElement>("addAgent").value || undefined;
  const c = await guard(() => api.characters.add(name, pickedImage!, agentId), `${name} added`);
  if (c) {
    $("addForm").hidden = true;
    $<HTMLInputElement>("addName").value = "";
    $<HTMLSelectElement>("addAgent").value = ANY_AGENT;
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
  const characterChanged = s.characterId !== settings?.characterId;
  settings = s;
  renderSettings(characterChanged);
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
