// Owns the OpenClaw connection lifecycle and turns gateway events into pet state.
//
// Token policy: the only method that starts an agent turn is `chat.send`, and it
// is called exclusively from `sendQuickChat` when the user presses Enter.
// Everything else (`sessions.list`, `sessions.subscribe`, event handling) is
// metadata-only and free.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  ActivityState,
  ChatStatusUpdate,
  ConnectionInfo,
  GatewaySettings,
  PetSnapshot,
  QuickChatResult,
  ReactionState,
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
/** Session key fragments that are background/automation and should not drive the pet. */
const IGNORED_SESSION_FRAGMENTS = [":cron:", ":heartbeat", ":hook:", ":webhook:", "explicit:model-run-", "incognito-"];

export class OpenClawController extends EventEmitter {
  private client: GatewayClient | null = null;
  private enabled = false;
  private gatewaySettings: GatewaySettings = { mode: "auto" };
  private reactionsEnabled = true;
  private reactionDurationMs = 7000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reactionTimer: NodeJS.Timeout | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private runs = new Map<string, ActiveRun>();
  private sessions = new Map<string, SessionRow>();
  private myRunIds = new Set<string>();
  private lastReply?: { text: string; at: number };
  private reaction: ReactionState = null;
  private reactionSetAt = 0;
  private connection: ConnectionInfo = { status: "off" };
  private generation = 0;

  constructor(private readonly opts: ControllerOptions) {
    super();
  }

  // ---- public API -----------------------------------------------------------

  configure(params: { enabled: boolean; gateway: GatewaySettings; reactionsEnabled: boolean; reactionDurationMs: number }): void {
    const gatewayChanged = JSON.stringify(params.gateway) !== JSON.stringify(this.gatewaySettings);
    this.gatewaySettings = params.gateway;
    this.reactionsEnabled = params.reactionsEnabled;
    this.reactionDurationMs = params.reactionDurationMs;
    if (!params.reactionsEnabled) this.setReaction(null);
    if (params.enabled && (!this.enabled || gatewayChanged)) {
      this.enabled = true;
      this.restart();
    } else if (!params.enabled && this.enabled) {
      this.enabled = false;
      this.stop();
    }
  }

  getConnection(): ConnectionInfo {
    return { ...this.connection, targetSession: this.describeTargetSession() };
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
    const runId = randomUUID();
    this.myRunIds.add(runId);
    try {
      const res = await this.client.request<{ runId?: string; status?: string }>("chat.send", {
        sessionKey: target.key,
        ...(target.agentId ? { agentId: target.agentId } : {}),
        message,
        idempotencyKey: runId,
      });
      const actualRunId = typeof res?.runId === "string" ? res.runId : runId;
      if (actualRunId !== runId) {
        this.myRunIds.delete(runId);
        this.myRunIds.add(actualRunId);
      }
      this.emitChatStatus({ runId: actualRunId, phase: "sent" });
      return { ok: true, runId: actualRunId };
    } catch (err) {
      this.myRunIds.delete(runId);
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
  }

  // ---- events → state -------------------------------------------------------

  private handleEvent(event: string, payload: any): void {
    switch (event) {
      case "chat":
        this.handleChatEvent(payload);
        break;
      case "agent":
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
      case "delta":
        this.touchRun(p.runId, p.sessionKey, p.agentId, mine);
        if (mine && p.state === "delta") this.emitChatStatus({ runId: p.runId, phase: "thinking" });
        break;
      case "final":
      case "error":
      case "aborted": {
        this.runs.delete(p.runId);
        const text = extractMessageText(p.message);
        if (p.state === "final" && text) this.lastReply = { text: truncate(text, 280), at: Date.now() };
        const reaction = classifyOutcome({ state: p.state, text, errorKind: p.errorKind });
        this.setReaction(reaction);
        if (mine) {
          this.myRunIds.delete(p.runId);
          if (p.state === "final") this.emitChatStatus({ runId: p.runId, phase: "reply", text: truncate(text, 280) });
          else if (p.state === "error") this.emitChatStatus({ runId: p.runId, phase: "error", text: friendlyRunError(p) });
          else this.emitChatStatus({ runId: p.runId, phase: "aborted" });
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

  private handleObserver(p: any): void {
    if (!p || typeof p.health !== "string" || typeof p.runId !== "string") return;
    if (!this.runs.has(p.runId)) return;
    if (p.health === "waiting-on-user") this.setReaction("question");
    this.emitSnapshot();
  }

  private handleSessionsChanged(p: any): void {
    const rows: SessionRow[] = Array.isArray(p?.sessions) ? p.sessions : p?.session ? [p.session] : p?.key ? [p] : [];
    for (const row of rows) if (row && typeof row.key === "string") this.rememberSession(row);
    if (rows.length) this.emit("connection", this.getConnection());
  }

  // ---- helpers --------------------------------------------------------------

  private touchRun(runId: string, sessionKey: string, agentId: string | undefined, mine: boolean): ActiveRun {
    let run = this.runs.get(runId);
    if (!run) {
      run = { sessionKey, agentId, startedAt: Date.now(), toolsRunning: 0, mine };
      this.runs.set(runId, run);
    }
    return run;
  }

  private pruneStaleRuns(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) if (now - run.startedAt > STALE_RUN_MS) this.runs.delete(id);
  }

  private activity(): ActivityState {
    this.pruneStaleRuns();
    if (this.runs.size === 0) return "idle";
    for (const run of this.runs.values()) if (run.toolsRunning > 0) return "working";
    return "thinking";
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
    }, Math.max(REACTION_MIN_VISIBLE_MS, this.reactionDurationMs));
  }

  private rememberSession(row: SessionRow): void {
    if (row.archived) {
      this.sessions.delete(row.key);
      return;
    }
    const prev = this.sessions.get(row.key);
    this.sessions.set(row.key, { ...prev, ...row });
  }

  private isIgnoredSession(key: string): boolean {
    return IGNORED_SESSION_FRAGMENTS.some((f) => key.includes(f));
  }

  /** "Most recent session the user was using": highest lastInteractionAt, ignoring automation rows. */
  private pickTargetSession(): SessionRow | null {
    let best: SessionRow | null = null;
    for (const row of this.sessions.values()) {
      if (this.isIgnoredSession(row.key)) continue;
      if (row.kind && ["cron", "hook", "heartbeat", "subagent"].includes(row.kind)) continue;
      const t = row.lastInteractionAt ?? row.updatedAt ?? 0;
      const bestT = best ? (best.lastInteractionAt ?? best.updatedAt ?? 0) : -1;
      if (t > bestT) best = row;
    }
    if (!best) {
      // Fall back to the main session of the first known agent (or "main").
      const agentId = [...this.sessions.values()][0]?.agentId ?? "main";
      return { key: `agent:${agentId}:main`, agentId };
    }
    return best;
  }

  private describeTargetSession(): ConnectionInfo["targetSession"] {
    if (this.connection.status !== "connected") return undefined;
    const s = this.pickTargetSession();
    if (!s) return undefined;
    const label = s.label || s.displayName || s.derivedTitle || (s.key.endsWith(":main") ? "Main session" : s.key.split(":").slice(-1)[0]);
    return { key: s.key, label, agentId: s.agentId };
  }

  private setConnection(info: ConnectionInfo): void {
    this.connection = info;
    this.emit("connection", this.getConnection());
  }

  private emitSnapshot(): void {
    this.emit("snapshot", this.getSnapshot());
  }

  private emitChatStatus(update: ChatStatusUpdate): void {
    this.emit("chatStatus", update);
  }
}

// ---- error explanations -----------------------------------------------------

function normalizeWsUrl(raw: string): string {
  let url = raw.trim();
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  return url.replace(/\/+$/, "");
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
