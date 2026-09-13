// Owns the OpenClaw connection lifecycle and turns gateway events into pet state.
//
// Token policy: the only method that starts an agent turn is `chat.send`, and it
// is called exclusively from `sendQuickChat` when the user presses Enter.
// Everything else (`sessions.list`, `sessions.subscribe`, event handling) is
// metadata-only and free.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  type ActivityState,
  type AgentOption,
  type ChatStatusUpdate,
  type ConnectionInfo,
  type GatewaySettings,
  type PetSnapshot,
  type QuickChatActionResult,
  type QuickChatResult,
  type QuickChatSessionOption,
  type ReactionKind,
  type ReactionState,
} from "../../shared/types";
import { discoverLocalGateway } from "./discovery";
import type { DeviceIdentity } from "./device-identity";
import { GatewayClient, type GatewayError } from "./gateway-client";
import { classifyOutcome, extractMessageText } from "./reactions";

interface SessionRow {
  key: string;
  agentId?: string;
  kind?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt?: number;
  lastInteractionAt?: number;
  hasActiveRun?: boolean;
  archived?: boolean;
}

interface ActiveRun {
  sessionKey: string;
  agentId?: string;
  startedAt: number;
  toolsRunning: number;
  mine: boolean;
}

export interface ControllerOptions {
  identity: DeviceIdentity;
  clientVersion: string;
  platform: string;
  log?: (msg: string) => void;
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const REACTION_MIN_VISIBLE_MS = 2_500;
const STALE_RUN_MS = 10 * 60_000;
const CHAT_STREAM_THROTTLE_MS = 50;
const MAX_TRACKED_SESSIONS = 100;
/** Session key fragments that are background/automation and should not drive the pet. */
const IGNORED_SESSION_FRAGMENTS = [":cron:", ":heartbeat", ":hook:", ":webhook:", "explicit:model-run-", "incognito-"];

export class OpenClawController extends EventEmitter {
  private client: GatewayClient | null = null;
  private enabled = false;
  private gatewaySettings: GatewaySettings = { mode: "auto" };
  private reactionsEnabled = true;
  private reactionHoldMs: Record<ReactionKind, number> = { ...DEFAULT_SETTINGS.reactionHoldMs };
  /** Agent the active character is bound to; null = any agent, most recent session. */
  private targetAgentId: string | null = null;
  /** Optional exact session chosen in the pet popover. Cleared when the character's agent changes. */
  private targetSessionKey: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reactionTimer: NodeJS.Timeout | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private runs = new Map<string, ActiveRun>();
  private sessions = new Map<string, SessionRow>();
  /** Quick chats awaiting a terminal reply, bounded by the same stale timeout as observed runs. */
  private myRunIds = new Map<string, { sessionKey: string; startedAt: number }>();
  /** Sessions the gateway reports as running (sessions.changed / user transcript entries), keyed by session. */
  private activeSessions = new Map<string, number>();
  private pendingStreamStatus: ChatStatusUpdate | null = null;
  private streamStatusTimer: NodeJS.Timeout | null = null;
  private lastChatStatusSignature = "";
  private lastSnapshotSignature = "";
  private subscribedKey: string | null = null;
  private lastReplyKey = "";
  private lastReply?: { text: string; at: number };
  private reaction: ReactionState = null;
  private reactionSetAt = 0;
  private connection: ConnectionInfo = { status: "off" };
  private generation = 0;

  constructor(private readonly opts: ControllerOptions) {
    super();
  }

  // ---- public API -----------------------------------------------------------

  configure(params: {
    enabled: boolean;
    gateway: GatewaySettings;
    reactionsEnabled: boolean;
    reactionHoldMs: Record<ReactionKind, number>;
  }): void {
    const gatewayChanged = JSON.stringify(params.gateway) !== JSON.stringify(this.gatewaySettings);
    this.gatewaySettings = params.gateway;
    this.reactionsEnabled = params.reactionsEnabled;
    this.reactionHoldMs = { ...params.reactionHoldMs };
    if (!params.reactionsEnabled) this.setReaction(null);
    if (params.enabled && (!this.enabled || gatewayChanged)) {
      this.enabled = true;
      this.restart();
    } else if (!params.enabled && this.enabled) {
      this.enabled = false;
      this.stop();
    }
  }

  /**
   * Binds the quick chat to one agent (the active character's `agentId`) or to none. Re-targets the
   * session and moves the transcript subscription right away; no tokens involved.
   */
  setTargetAgent(agentId: string | null | undefined): void {
    const next = agentId?.trim() || null;
    if (next === this.targetAgentId) return;
    this.targetAgentId = next;
    this.targetSessionKey = null;
    this.opts.log?.(`target agent → ${next ?? "(any)"}`);
    this.emit("connection", this.getConnection());
    void this.syncMessageSubscription();
  }

  getConnection(): ConnectionInfo {
    return { ...this.connection, targetSession: this.describeTargetSession() };
  }

  /** Visible agents (`agents.list`, metadata-only). System rows are dropped; an empty list means "unknown". */
  async listAgents(): Promise<AgentOption[]> {
    const client = this.client;
    if (!client?.connected) return [];
    try {
      const res = await client.request<{ defaultId?: string; agents?: Array<{ id?: string; kind?: string; name?: string; identity?: { name?: string; emoji?: string } }> }>(
        "agents.list",
        {},
      );
      const out: AgentOption[] = [];
      for (const a of res?.agents ?? []) {
        if (!a || typeof a.id !== "string" || !a.id || a.kind === "system") continue;
        out.push({
          id: a.id,
          name: a.identity?.name || a.name || a.id,
          ...(a.identity?.emoji ? { emoji: a.identity.emoji } : {}),
          ...(res?.defaultId === a.id ? { isDefault: true } : {}),
        });
      }
      return out;
    } catch (err) {
      this.opts.log?.(`agents.list failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Recent user conversations already held in memory. This does not call a model. */
  listSessions(agentId?: string): QuickChatSessionOption[] {
    const wanted = agentId?.trim() || this.targetAgentId;
    return [...this.sessions.values()]
      .filter((row) => this.isSelectableSession(row) && (!wanted || sessionAgentId(row) === wanted))
      .sort((a, b) => (b.lastInteractionAt ?? b.updatedAt ?? 0) - (a.lastInteractionAt ?? a.updatedAt ?? 0))
      .slice(0, 10)
      .map((row) => ({
        key: row.key,
        label: this.sessionLabel(row),
        ...(sessionAgentId(row) ? { agentId: sessionAgentId(row) } : {}),
        ...(row.lastInteractionAt ?? row.updatedAt ? { lastInteractionAt: row.lastInteractionAt ?? row.updatedAt } : {}),
        ...(row.key === this.targetSessionKey ? { selected: true } : {}),
      }));
  }

  /** Pins quick chat to one recent session, or clears the pin to resume automatic targeting. */
  setTargetSession(sessionKey: string | null): QuickChatActionResult {
    const key = sessionKey?.trim() || null;
    if (!key) {
      this.targetSessionKey = null;
      this.emit("connection", this.getConnection());
      void this.syncMessageSubscription();
      return { ok: true };
    }
    const row = this.sessions.get(key);
    if (!row || !this.isSelectableSession(row)) return { ok: false, error: "That recent session is no longer available." };
    if (this.targetAgentId && sessionAgentId(row) !== this.targetAgentId) {
      return { ok: false, error: "That session belongs to a different agent." };
    }
    this.targetSessionKey = key;
    this.emit("connection", this.getConnection());
    void this.syncMessageSubscription();
    return { ok: true };
  }

  getSnapshot(): PetSnapshot {
    return {
      activity: this.activity(),
      reaction: this.reaction,
      connection: this.connection.status,
      lastReply: this.lastReply?.text,
      lastReplyAt: this.lastReply?.at,
    };
  }

  /** Sends a user message to the most recent session. This is the ONLY LLM-consuming call in the app. */
  async sendQuickChat(text: string): Promise<QuickChatResult> {
    const message = text.trim();
    if (!message) return { ok: false, error: "Nothing to send." };
    if (!this.client?.connected) return { ok: false, error: "OpenClaw is not connected." };
    const target = this.pickTargetSession();
    if (!target) return { ok: false, error: "No OpenClaw session found yet." };
    await this.syncMessageSubscription();
    const route = await this.resolveDeliveryRoute(target);
    const runId = randomUUID();
    this.myRunIds.set(runId, { sessionKey: target.key, startedAt: Date.now() });
    try {
      const res = await this.client.request<{ runId?: string; status?: string }>("chat.send", {
        sessionKey: target.key,
        ...(target.agentId ? { agentId: target.agentId } : {}),
        message,
        idempotencyKey: runId,
        ...route,
      });
      this.opts.log?.(`chat.send → ${JSON.stringify(res).slice(0, 300)}`);
      const actualRunId = typeof res?.runId === "string" ? res.runId : runId;
      if (actualRunId !== runId) {
        const pending = this.myRunIds.get(runId)!;
        this.myRunIds.delete(runId);
        this.myRunIds.set(actualRunId, pending);
      }
      this.activeSessions.set(target.key, Date.now());
      this.emitChatStatus({ runId: actualRunId, phase: "sent" });
      this.emitSnapshot();
      return { ok: true, runId: actualRunId };
    } catch (err) {
      this.myRunIds.delete(runId);
      return { ok: false, error: friendlyRequestError(err as GatewayError) };
    }
  }

  /** Stops one quick-chat run using the gateway's official chat.abort method. */
  async abortQuickChat(runId?: string): Promise<QuickChatActionResult> {
    const client = this.client;
    if (!client?.connected) return { ok: false, error: "OpenClaw is not connected." };
    const pendingEntry = runId
      ? ([runId, this.myRunIds.get(runId)] as const)
      : [...this.myRunIds.entries()].sort(([, a], [, b]) => b.startedAt - a.startedAt)[0];
    if (!pendingEntry?.[1]) return { ok: false, error: "That reply is no longer running." };
    const [id, pending] = pendingEntry as readonly [string, { sessionKey: string; startedAt: number }];
    try {
      const res = await client.request<{ ok?: boolean; aborted?: boolean; runIds?: string[] }>("chat.abort", {
        sessionKey: pending.sessionKey,
        runId: id,
      });
      if (res?.ok === false || res?.aborted === false) return { ok: false, error: "OpenClaw could not stop that reply." };
      const abortedIds = new Set([id, ...(Array.isArray(res?.runIds) ? res.runIds : [])]);
      for (const abortedId of abortedIds) {
        const chat = this.myRunIds.get(abortedId);
        this.myRunIds.delete(abortedId);
        this.runs.delete(abortedId);
        if (chat) this.activeSessions.delete(chat.sessionKey);
      }
      this.emitChatStatus({ runId: id, phase: "aborted" });
      this.emitSnapshot();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyRequestError(err as GatewayError) };
    }
  }

  dispose(): void {
    this.enabled = false;
    this.stop();
  }

  // ---- connection lifecycle -------------------------------------------------

  private restart(): void {
    this.stop(false);
    this.backoffMs = BACKOFF_MIN_MS;
    void this.connectOnce();
  }

  private stop(emitOff = true): void {
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    client?.removeAllListeners();
    client?.close();
    this.runs.clear();
    this.activeSessions.clear();
    this.myRunIds.clear();
    this.clearPendingStreamStatus();
    this.lastChatStatusSignature = "";
    this.subscribedKey = null;
    this.setReaction(null);
    if (emitOff) this.setConnection({ status: "off" });
    this.emitSnapshot();
  }

  private resolveEndpoint(): { url: string; token?: string; password?: string; note?: string; configPath?: string } {
    const g = this.gatewaySettings;
    if (g.mode === "manual" && g.url?.trim()) {
      return { url: normalizeWsUrl(g.url), token: g.token, password: g.password };
    }
    const found = discoverLocalGateway();
    return {
      url: found.url,
      token: g.token?.trim() || found.token,
      password: g.password?.trim() || found.password,
      note: found.note,
      configPath: found.configPath,
    };
  }

  private async connectOnce(): Promise<void> {
    if (!this.enabled) return;
    const gen = ++this.generation;
    const endpoint = this.resolveEndpoint();
    this.setConnection({
      status: this.connection.status === "connected" || this.connection.status === "reconnecting" ? "reconnecting" : "connecting",
      gatewayUrl: endpoint.url,
    });
    const client = new GatewayClient({
      url: endpoint.url,
      token: endpoint.token,
      password: endpoint.password,
      identity: this.opts.identity,
      clientVersion: this.opts.clientVersion,
      platform: this.opts.platform,
      log: this.opts.log,
    });
    this.client = client;
    client.on("event", (event: string, payload: unknown) => {
      if (gen !== this.generation) return;
      this.handleEvent(event, payload);
    });
    client.on("disconnected", ({ byUser, reason }: { byUser: boolean; reason: string }) => {
      if (gen !== this.generation || byUser) return;
      this.runs.clear();
      this.activeSessions.clear();
      this.subscribedKey = null;
      this.opts.log?.(`disconnected: ${reason}`);
      this.setConnection({ status: "reconnecting", hint: "OpenClaw went away. Reconnecting…", gatewayUrl: endpoint.url });
      this.emitSnapshot();
      this.scheduleReconnect();
    });
    try {
      const hello = await client.connect();
      if (gen !== this.generation) {
        client.close();
        return;
      }
      this.backoffMs = BACKOFF_MIN_MS;
      this.opts.log?.(`connected to gateway ${hello.server.version} as ${hello.auth.role} [${hello.auth.scopes.join(",")}]`);
      this.setConnection({ status: "connected", gatewayUrl: endpoint.url });
      await this.bootstrapSessions();
      this.emitSnapshot();
    } catch (err) {
      if (gen !== this.generation) return;
      const { hint, detail, retry } = explainConnectError(err as GatewayError, endpoint);
      this.opts.log?.(`connect failed: ${(err as Error).message}`);
      this.setConnection({ status: "error", hint, detail, gatewayUrl: endpoint.url });
      this.emitSnapshot();
      if (retry) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(BACKOFF_MAX_MS, Math.round(this.backoffMs * 1.8));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delay);
  }

  private async bootstrapSessions(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      // Subscribe first (so we do not miss sessions.changed), and take the initial list in the same call.
      const res = await client.request<{ subscribed: boolean; list?: { sessions?: SessionRow[] } }>("sessions.subscribe", {
        limit: 40,
        sortBy: "lastInteractionAt",
        requireLastInteraction: true,
        configuredAgentsOnly: true,
      });
      for (const row of res?.list?.sessions ?? []) this.rememberSession(row);
      this.opts.log?.(`sessions loaded: ${this.sessions.size}`);
    } catch (err) {
      this.opts.log?.(`sessions.subscribe failed: ${(err as Error).message}`);
      try {
        const list = await client.request<{ sessions?: SessionRow[] }>("sessions.list", { limit: 40, sortBy: "lastInteractionAt" });
        for (const row of list?.sessions ?? []) this.rememberSession(row);
      } catch (err2) {
        this.opts.log?.(`sessions.list failed: ${(err2 as Error).message}`);
      }
    }
    this.emit("connection", this.getConnection());
    await this.syncMessageSubscription();
  }

  /**
   * Transcript events (`session.message`) are the one reply source that does not depend on how a run
   * was executed (embedded runner, Claude CLI runtime, restart recovery…), so the pet subscribes to
   * them for the session the quick chat targets. Metadata-only, no tokens.
   */
  private async syncMessageSubscription(): Promise<void> {
    const client = this.client;
    if (!client?.connected) return;
    const target = this.pickTargetSession();
    if (!target || target.key === this.subscribedKey) return;
    const previous = this.subscribedKey;
    this.subscribedKey = target.key;
    try {
      if (previous) await client.request("sessions.messages.unsubscribe", { key: previous }).catch(() => undefined);
      await client.request("sessions.messages.subscribe", { key: target.key, ...(target.agentId ? { agentId: target.agentId } : {}) });
      this.opts.log?.(`subscribed to messages of ${target.key}`);
    } catch (err) {
      this.subscribedKey = null;
      this.opts.log?.(`sessions.messages.subscribe failed: ${(err as Error).message}`);
    }
  }

  // ---- events → state -------------------------------------------------------

  private handleEvent(event: string, payload: any): void {
    if (event !== "tick" && event !== "presence" && event !== "health") {
      this.opts.log?.(
        `event ${event}${payload?.state ? ` state=${payload.state}` : ""}${payload?.stream ? ` stream=${payload.stream}` : ""}${payload?.sessionKey ? ` session=${payload.sessionKey}` : ""}${payload?.runId ? ` run=${String(payload.runId).slice(0, 8)}` : ""}${process.env.OPENCLAW_PET_DEBUG_PAYLOADS ? ` ${JSON.stringify(payload).slice(0, 600)}` : ""}`,
      );
    }
    switch (event) {
      case "chat":
        this.handleChatEvent(payload);
        break;
      case "agent":
        this.handleAgentEvent(payload);
        break;
      case "session.message":
        this.handleSessionMessage(payload);
        break;
      case "session.tool":
        this.handleAgentEvent(payload);
        break;
      case "session.observer":
        this.handleObserver(payload);
        break;
      case "sessions.changed":
        this.handleSessionsChanged(payload);
        break;
      case "shutdown":
        this.setConnection({ status: "reconnecting", hint: "OpenClaw is restarting…", gatewayUrl: this.connection.gatewayUrl });
        this.emitSnapshot();
        break;
      default:
        break;
    }
  }

  private handleChatEvent(p: any): void {
    if (!p || typeof p.runId !== "string" || typeof p.sessionKey !== "string") return;
    if (this.isIgnoredSession(p.sessionKey)) return;
    const mine = this.myRunIds.has(p.runId);
    switch (p.state) {
      case "status":
      case "delta": {
        const run = this.touchRun(p.runId, p.sessionKey, p.agentId, mine);
        if (mine && run.toolsRunning === 0) {
          this.emitChatStatus({ runId: p.runId, phase: "thinking", ...(p.state === "delta" ? { text: extractMessageText(p.message) } : {}) });
        }
        break;
      }
      case "final":
      case "error":
      case "aborted": {
        if (this.runs.delete(p.runId)) this.opts.log?.(`run ${p.runId.slice(0, 8)} ${p.state} (${p.sessionKey})`);
        this.activeSessions.delete(p.sessionKey);
        const text = extractMessageText(p.message);
        if (p.state === "final") {
          // A final without text (slash commands, some runtimes) is completed by the session.message event.
          if (text) this.applyReply(p.sessionKey, text, p.runId);
        } else {
          this.setReaction(classifyOutcome({ state: p.state, text, errorKind: p.errorKind }));
          if (mine) {
            this.myRunIds.delete(p.runId);
            if (p.state === "error") this.emitChatStatus({ runId: p.runId, phase: "error", text: friendlyRunError(p) });
            else this.emitChatStatus({ runId: p.runId, phase: "aborted" });
          }
        }
        break;
      }
      default:
        break;
    }
    this.emitSnapshot();
  }

  private handleAgentEvent(p: any): void {
    if (!p || typeof p.runId !== "string" || p.isHeartbeat) return;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : this.runs.get(p.runId)?.sessionKey;
    if (sessionKey && this.isIgnoredSession(sessionKey)) return;
    const data = p.data ?? {};
    const mine = this.myRunIds.has(p.runId);
    switch (p.stream) {
      case "lifecycle":
        if (data.phase === "start") this.touchRun(p.runId, sessionKey ?? "", p.agentId, mine);
        else if (data.phase === "end" || data.phase === "error") {
          // The `chat` terminal event carries the reply; lifecycle just guarantees cleanup.
          setTimeout(() => {
            if (this.runs.has(p.runId)) {
              this.runs.delete(p.runId);
              this.emitSnapshot();
            }
          }, 1500);
        }
        break;
      case "tool": {
        const run = this.touchRun(p.runId, sessionKey ?? "", p.agentId, mine);
        if (data.phase === "start") run.toolsRunning += 1;
        else if (data.phase === "end" || data.phase === "error") run.toolsRunning = Math.max(0, run.toolsRunning - 1);
        if (mine) this.emitChatStatus({ runId: p.runId, phase: run.toolsRunning > 0 ? "working" : "thinking" });
        break;
      }
      case "assistant":
        this.touchRun(p.runId, sessionKey ?? "", p.agentId, mine);
        break;
      default:
        break;
    }
    this.emitSnapshot();
  }

  /** Transcript update for a subscribed session: the authoritative reply text, whatever runtime produced it. */
  private handleSessionMessage(p: any): void {
    if (!p || typeof p.sessionKey !== "string" || !p.message || typeof p.message !== "object") return;
    if (this.isIgnoredSession(p.sessionKey)) return;
    const role = p.message.role;
    if (role === "user") {
      // Someone (maybe us) just asked something: a run is about to start.
      this.activeSessions.set(p.sessionKey, Date.now());
      this.emitSnapshot();
      return;
    }
    if (role !== "assistant") return;
    const text = extractMessageText(p.message);
    if (!text.trim()) return;
    const runId = typeof p.runId === "string" ? p.runId : typeof p.message.idempotencyKey === "string" ? p.message.idempotencyKey.split(":")[0] : undefined;
    for (const [id, run] of this.runs) if (run.sessionKey === p.sessionKey) this.runs.delete(id);
    this.activeSessions.delete(p.sessionKey);
    this.applyReply(p.sessionKey, text, runId);
  }

  /** Records a finished reply once (chat final and session.message can both carry it) and reacts to it. */
  private applyReply(sessionKey: string, text: string, runId?: string): void {
    const key = `${sessionKey}|${text.slice(0, 200)}`;
    if (key === this.lastReplyKey) return;
    this.lastReplyKey = key;
    const short = truncate(text, 280);
    this.lastReply = { text: short, at: Date.now() };
    this.setReaction(classifyOutcome({ state: "final", text }));
    // The pet's own quick chat: deliver the reply to the bubble. The run id of the transcript entry can differ
    // from the chat.send id (runtime resumes, recovery runs), so any pending quick chat on this session counts.
    const pending =
      runId && this.myRunIds.has(runId)
        ? runId
        : [...this.myRunIds].find(([, chat]) => chat.sessionKey === sessionKey)?.[0] ?? null;
    if (pending) {
      for (const [id, chat] of this.myRunIds) if (chat.sessionKey === sessionKey) this.myRunIds.delete(id);
      this.emitChatStatus({ runId: pending, phase: "reply", text: short });
    }
    this.emitSnapshot();
  }

  private handleObserver(p: any): void {
    if (!p || typeof p.health !== "string" || typeof p.runId !== "string") return;
    if (!this.runs.has(p.runId)) return;
    if (p.health === "waiting-on-user") this.setReaction("question");
    this.emitSnapshot();
  }

  private handleSessionsChanged(p: any): void {
    const raw: any[] = Array.isArray(p?.sessions) ? p.sessions : p?.session ? [p.session] : p ? [p] : [];
    const rows: SessionRow[] = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const key = typeof r.key === "string" ? r.key : typeof r.sessionKey === "string" ? r.sessionKey : null;
      if (!key) continue;
      const row: SessionRow = { ...r, key };
      rows.push(row);
      this.rememberSession(row);
      if (this.isIgnoredSession(key)) continue;
      // `hasActiveRun` is the gateway's authoritative activity fact; the reason strings are the cheap live hint.
      if (row.hasActiveRun === true || r.reason === "chat.run.started") this.activeSessions.set(key, Date.now());
      else if (row.hasActiveRun === false || r.reason === "chat.run.settled" || r.reason === "chat.run.aborted") this.activeSessions.delete(key);
    }
    if (rows.length) {
      this.emit("connection", this.getConnection());
      this.emitSnapshot();
      void this.syncMessageSubscription();
    }
  }

  // ---- helpers --------------------------------------------------------------

  private touchRun(runId: string, sessionKey: string, agentId: string | undefined, mine: boolean): ActiveRun {
    let run = this.runs.get(runId);
    if (!run) {
      run = { sessionKey, agentId, startedAt: Date.now(), toolsRunning: 0, mine };
      this.runs.set(runId, run);
      this.opts.log?.(`run ${runId.slice(0, 8)} started (${sessionKey || "?"})${mine ? " [quick chat]" : ""}`);
    }
    return run;
  }

  private pruneStaleRuns(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) if (now - run.startedAt > STALE_RUN_MS) this.runs.delete(id);
    for (const [key, at] of this.activeSessions) if (now - at > STALE_RUN_MS) this.activeSessions.delete(key);
    for (const [id, chat] of this.myRunIds) if (now - chat.startedAt > STALE_RUN_MS) this.myRunIds.delete(id);
  }

  private activity(): ActivityState {
    this.pruneStaleRuns();
    for (const run of this.runs.values()) if (run.toolsRunning > 0) return "working";
    if (this.runs.size > 0 || this.activeSessions.size > 0) return "thinking";
    return "idle";
  }

  private setReaction(reaction: ReactionState): void {
    if (this.reactionTimer) clearTimeout(this.reactionTimer);
    this.reactionTimer = null;
    if (!reaction || !this.reactionsEnabled) {
      this.reaction = null;
      return;
    }
    this.reaction = reaction;
    this.reactionSetAt = Date.now();
    this.reactionTimer = setTimeout(() => {
      this.reaction = null;
      this.reactionTimer = null;
      this.emitSnapshot();
    }, Math.max(REACTION_MIN_VISIBLE_MS, this.reactionHoldMs[reaction] ?? DEFAULT_SETTINGS.reactionHoldMs[reaction]));
  }

  private rememberSession(row: SessionRow): void {
    if (row.archived) {
      this.sessions.delete(row.key);
      if (this.targetSessionKey === row.key) this.targetSessionKey = null;
      return;
    }
    const prev = this.sessions.get(row.key);
    this.sessions.set(row.key, { ...prev, ...row });
    this.pruneSessions();
  }

  /** Keeps months of sessions.changed traffic from growing the tray app forever. */
  private pruneSessions(): void {
    const excess = this.sessions.size - MAX_TRACKED_SESSIONS;
    if (excess <= 0) return;
    const protectedKeys = new Set(this.activeSessions.keys());
    if (this.subscribedKey) protectedKeys.add(this.subscribedKey);
    if (this.targetSessionKey) protectedKeys.add(this.targetSessionKey);
    const oldest = [...this.sessions.entries()]
      .filter(([key]) => !protectedKeys.has(key))
      .sort(([, a], [, b]) => (a.lastInteractionAt ?? a.updatedAt ?? 0) - (b.lastInteractionAt ?? b.updatedAt ?? 0));
    for (let i = 0; i < Math.min(excess, oldest.length); i += 1) this.sessions.delete(oldest[i][0]);
  }

  private isIgnoredSession(key: string): boolean {
    return IGNORED_SESSION_FRAGMENTS.some((f) => key.includes(f));
  }

  private isSelectableSession(row: SessionRow): boolean {
    return !row.archived && !this.isIgnoredSession(row.key) && (!row.kind || ["direct", "main", "thread"].includes(row.kind));
  }

  /**
   * "Most recent session the user was using": highest lastInteractionAt among the user's own
   * conversations. Automation rows and shared group/channel rooms are skipped: a quick chat from the
   * desktop belongs in the personal (main/direct) conversation, not in someone's Discord channel.
   * When the active character is bound to an agent, only that agent's sessions count, and its
   * `agent:<id>:main` session is used until it has one.
   */
  private pickTargetSession(): SessionRow | null {
    const wanted = this.targetAgentId;
    if (this.targetSessionKey) {
      const selected = this.sessions.get(this.targetSessionKey);
      if (selected && this.isSelectableSession(selected) && (!wanted || sessionAgentId(selected) === wanted)) return selected;
      this.targetSessionKey = null;
    }
    let best: SessionRow | null = null;
    for (const row of this.sessions.values()) {
      if (!this.isSelectableSession(row)) continue;
      if (wanted && sessionAgentId(row) !== wanted) continue;
      const t = row.lastInteractionAt ?? row.updatedAt ?? 0;
      const bestT = best ? (best.lastInteractionAt ?? best.updatedAt ?? 0) : -1;
      if (t > bestT) best = row;
    }
    if (!best) {
      // Fall back to the main session of the bound agent, else of the first known agent (or "main").
      const agentId = wanted ?? [...this.sessions.values()][0]?.agentId ?? "main";
      return { key: `agent:${agentId}:main`, agentId };
    }
    return best;
  }

  /**
   * A quick chat should feel like one continuous conversation with the user's chat app, so the reply
   * is also delivered to the session's stored route (e.g. the Discord DM). Without an explicit route
   * the gateway keeps webchat-style replies internal and never mirrors them to a channel.
   * `sessions.describe` is metadata-only (no tokens).
   */
  private async resolveDeliveryRoute(target: SessionRow): Promise<Record<string, unknown>> {
    if (!this.client?.connected) return {};
    // The gateway rejects explicit originating-route fields without operator.admin.
    if (!this.client.grantedScopes.includes("operator.admin")) return {};
    try {
      const res = await this.client.request<{
        session?: {
          deliveryContext?: { channel?: string; to?: string; accountId?: string; threadId?: string };
          lastChannel?: string;
          lastTo?: string;
          lastAccountId?: string;
          origin?: { provider?: string; to?: string; accountId?: string; threadId?: string };
        };
      }>("sessions.describe", { key: target.key, ...(target.agentId ? { agentId: target.agentId } : {}) });
      const s = res?.session;
      const channel = s?.deliveryContext?.channel ?? s?.lastChannel ?? s?.origin?.provider;
      const to = s?.deliveryContext?.to ?? s?.lastTo ?? s?.origin?.to;
      const accountId = s?.deliveryContext?.accountId ?? s?.lastAccountId ?? s?.origin?.accountId;
      const threadId = s?.deliveryContext?.threadId ?? s?.origin?.threadId;
      if (!channel || !to || channel === "webchat") return {};
      return {
        deliver: true,
        originatingChannel: channel,
        originatingTo: to,
        ...(accountId ? { originatingAccountId: accountId } : {}),
        ...(threadId ? { originatingThreadId: threadId } : {}),
      };
    } catch (err) {
      this.opts.log?.(`sessions.describe failed, sending without a delivery route: ${(err as Error).message}`);
      return {};
    }
  }

  private describeTargetSession(): ConnectionInfo["targetSession"] {
    if (this.connection.status !== "connected") return undefined;
    const s = this.pickTargetSession();
    if (!s) return undefined;
    return { key: s.key, label: this.sessionLabel(s), agentId: sessionAgentId(s) };
  }

  private sessionLabel(s: SessionRow): string {
    const isMain = /^agent:[^:]+:main$/.test(s.key);
    const title = s.derivedTitle || s.displayName || (isMain ? "" : s.label) || "";
    const label = isMain ? `Main conversation${title ? ` · ${title}` : ""}` : title || s.key.split(":").slice(-2).join(" ");
    return truncate(label, 80);
  }

  private setConnection(info: ConnectionInfo): void {
    this.connection = info;
    this.emit("connection", this.getConnection());
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    const signature = JSON.stringify(snapshot);
    if (signature === this.lastSnapshotSignature) return;
    this.lastSnapshotSignature = signature;
    this.emit("snapshot", snapshot);
  }

  private emitChatStatus(update: ChatStatusUpdate): void {
    // Gateway text deltas can arrive faster than the renderer can paint. Keep the newest partial
    // text and send at most one update per short frame window; terminal/status transitions remain
    // immediate and cancel any now-obsolete partial update.
    if (update.phase === "thinking" && typeof update.text === "string") {
      this.pendingStreamStatus = update;
      if (!this.streamStatusTimer) {
        this.streamStatusTimer = setTimeout(() => {
          this.streamStatusTimer = null;
          const pending = this.pendingStreamStatus;
          this.pendingStreamStatus = null;
          if (pending) this.emitChatStatusNow(pending);
        }, CHAT_STREAM_THROTTLE_MS);
      }
      return;
    }
    this.clearPendingStreamStatus();
    this.emitChatStatusNow(update);
  }

  private emitChatStatusNow(update: ChatStatusUpdate): void {
    const signature = JSON.stringify(update);
    if (signature === this.lastChatStatusSignature) return;
    this.lastChatStatusSignature = signature;
    this.emit("chatStatus", update);
  }

  private clearPendingStreamStatus(): void {
    if (this.streamStatusTimer) clearTimeout(this.streamStatusTimer);
    this.streamStatusTimer = null;
    this.pendingStreamStatus = null;
  }
}

// ---- error explanations -----------------------------------------------------

function normalizeWsUrl(raw: string): string {
  let url = raw.trim();
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  return url.replace(/\/+$/, "");
}

/** Agent of a session row: the explicit field, else the `agent:<id>:…` key prefix. */
function sessionAgentId(row: SessionRow): string | undefined {
  if (typeof row.agentId === "string" && row.agentId) return row.agentId;
  const m = /^agent:([^:]+):/.exec(row.key);
  return m?.[1];
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function friendlyRunError(p: any): string {
  switch (p?.errorKind) {
    case "rate_limit":
      return "OpenClaw hit a rate limit. Try again in a moment.";
    case "timeout":
      return "OpenClaw timed out on that one.";
    case "context_length":
      return "The conversation is too long for the model. Try /new in OpenClaw.";
    case "refusal":
      return "OpenClaw declined to answer that.";
    default:
      return typeof p?.errorMessage === "string" ? truncate(p.errorMessage, 160) : "OpenClaw could not finish that run.";
  }
}

function friendlyRequestError(err: GatewayError): string {
  if (err.code === "FORBIDDEN") return "This device is not allowed to send messages. Re-pair it in OpenClaw (openclaw devices).";
  if (err.code === "NOT_CONNECTED") return "OpenClaw is not connected.";
  if (err.code === "TIMEOUT") return "OpenClaw did not answer in time.";
  return truncate(err.message || "Could not send the message.", 160);
}

function explainConnectError(
  err: GatewayError,
  endpoint: { url: string; token?: string; password?: string; note?: string; configPath?: string },
): { hint: string; detail: string; retry: boolean } {
  const detail = `${err.code ?? "ERR"}${err.detailCode ? `/${err.detailCode}` : ""}: ${err.message}`;
  const code = err.detailCode ?? "";
  const msg = (err.message || "").toLowerCase();
  if (err.code === "SOCKET" || msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("connect")) {
    if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("timed out") || msg.includes("socket hang up")) {
      return {
        hint: "OpenClaw is not running. Start it (for example `openclaw gateway start`) and the pet will connect on its own.",
        detail,
        retry: true,
      };
    }
  }
  if (code === "AUTH_TOKEN_MISSING" || code === "AUTH_TOKEN_MISMATCH" || code === "AUTH_PASSWORD_MISSING" || code === "AUTH_PASSWORD_MISMATCH" || code === "AUTH_REQUIRED" || code === "AUTH_UNAUTHORIZED") {
    const hint = endpoint.token || endpoint.password
      ? "OpenClaw rejected the saved credentials. Open Settings → OpenClaw and paste the current gateway token (run `openclaw gateway auth-token --show`)."
      : endpoint.note ?? "OpenClaw needs a gateway token. Open Settings → OpenClaw and paste it (run `openclaw gateway auth-token --show`).";
    return { hint, detail, retry: false };
  }
  if (code === "PAIRING_REQUIRED" || msg.includes("pairing required")) {
    return {
      hint: "OpenClaw wants you to approve this device once. Run `openclaw devices list` then `openclaw devices approve <requestId>`.",
      detail,
      retry: true,
    };
  }
  if (code === "AUTH_SCOPE_MISMATCH" || msg.includes("scope")) {
    return {
      hint: "This device was paired with fewer permissions than the pet needs. Approve the new request with `openclaw devices approve <requestId>`.",
      detail,
      retry: true,
    };
  }
  if (code === "PROTOCOL_MISMATCH" || msg.includes("protocol")) {
    return { hint: "This OpenClaw version speaks a different protocol. Update OpenClaw or the pet.", detail, retry: false };
  }
  if (err.code === "TIMEOUT") {
    return { hint: "OpenClaw did not respond. It may still be starting up.", detail, retry: true };
  }
  if (err.retryable || err.code === "UNAVAILABLE") {
    return { hint: "OpenClaw is busy starting up. Retrying…", detail, retry: true };
  }
  return { hint: "Could not connect to OpenClaw. Check that it is running, then toggle OpenClaw off and on.", detail, retry: true };
}
