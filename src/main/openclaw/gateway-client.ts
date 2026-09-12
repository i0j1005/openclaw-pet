// Minimal OpenClaw Gateway WebSocket client (protocol v4).
//
// Deliberately small: one socket, request/response correlation, the
// challenge/connect handshake with device auth, and an event emitter.
// No polling: the Gateway pushes `chat`, `agent`, `sessions.changed`,
// `health`, `tick` and `shutdown` events on its own.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  buildDeviceAuthPayloadV3,
  publicKeyBase64Url,
  signPayload,
  type DeviceIdentity,
} from "./device-identity";

export const PROTOCOL_VERSION = 4;
export const CLIENT_ID = "gateway-client";
export const CLIENT_MODE = "ui";
export const CLIENT_DISPLAY_NAME = "OpenClaw Pet";
const REQUEST_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 15_000;

export interface GatewayClientOptions {
  url: string;
  token?: string;
  password?: string;
  identity: DeviceIdentity;
  clientVersion: string;
  platform: "darwin" | "win32" | "linux" | string;
  scopes?: string[];
  caps?: string[];
  log?: (msg: string) => void;
}

export interface GatewayError extends Error {
  code?: string;
  detailCode?: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export interface HelloOk {
  protocol: number;
  server: { version: string; connId: string };
  features: { methods: string[]; events: string[] };
  snapshot: Record<string, unknown>;
  auth: { role: string; scopes: string[]; deviceToken?: string };
  policy: { maxPayload: number; tickIntervalMs: number };
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

function platformIdentity(platform: string): { platform: string; deviceFamily?: string } {
  switch (platform) {
    case "darwin":
      return { platform: "macos", deviceFamily: "Mac" };
    case "win32":
      return { platform: "windows", deviceFamily: "Windows" };
    case "linux":
      return { platform: "linux", deviceFamily: "Linux" };
    default:
      return { platform };
  }
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closedByUser = false;
  hello: HelloOk | null = null;

  constructor(private readonly opts: GatewayClientOptions) {
    super();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.hello !== null;
  }

  get grantedScopes(): string[] {
    return this.hello?.auth.scopes ?? [];
  }

  /** Opens the socket and completes the handshake. Rejects with a GatewayError on failure. */
  connect(): Promise<HelloOk> {
    this.closedByUser = false;
    return new Promise<HelloOk>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(err);
      };
      const ws = new WebSocket(this.opts.url, {
        perMessageDeflate: false,
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        headers: { "User-Agent": `openclaw-pet/${this.opts.clientVersion}` },
      });
      this.ws = ws;
      const connectTimer = setTimeout(() => {
        fail(this.makeError("TIMEOUT", "Timed out waiting for the gateway handshake"));
        ws.terminate();
      }, CONNECT_TIMEOUT_MS);

      let sentConnect = false;
      const sendConnect = (nonce: string, ts: number) => {
        if (sentConnect) return;
        sentConnect = true;
        const id = randomUUID();
        const params = this.buildConnectParams(nonce, ts);
        this.pending.set(id, {
          resolve: (payload) => {
            clearTimeout(connectTimer);
            this.hello = payload as HelloOk;
            settled = true;
            this.emit("connected", this.hello);
            resolve(this.hello);
          },
          reject: (err) => {
            fail(err);
            ws.close(1000, "connect rejected");
          },
          timer: setTimeout(() => {
            this.pending.delete(id);
            fail(this.makeError("TIMEOUT", "Gateway did not answer the connect request"));
          }, CONNECT_TIMEOUT_MS),
        });
        ws.send(JSON.stringify({ type: "req", id, method: "connect", params }));
      };

      ws.on("open", () => {
        this.opts.log?.(`socket open → ${this.opts.url}`);
        // Wait briefly for connect.challenge; very old gateways never send one.
        setTimeout(() => {
          if (!sentConnect && ws.readyState === WebSocket.OPEN) sendConnect("", Date.now());
        }, 1500);
      });
      ws.on("message", (data) => {
        let frame: any;
        try {
          frame = JSON.parse(typeof data === "string" ? data : data.toString());
        } catch {
          return;
        }
        if (frame?.type === "event" && frame.event === "connect.challenge") {
          const nonce = typeof frame.payload?.nonce === "string" ? frame.payload.nonce : "";
          const ts = Number.isInteger(frame.payload?.ts) ? frame.payload.ts : Date.now();
          if (nonce) sendConnect(nonce, ts);
          return;
        }
        this.handleFrame(frame);
      });
      ws.on("error", (err) => {
        fail(this.makeError("SOCKET", (err as Error).message));
      });
      ws.on("close", (code, reasonBuf) => {
        const reason = reasonBuf?.toString() || "";
        clearTimeout(connectTimer);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(this.makeError("CLOSED", `gateway connection closed (${code}) ${reason}`.trim()));
        }
        this.pending.clear();
        const wasConnected = this.hello !== null;
        this.hello = null;
        this.ws = null;
        if (!settled) fail(this.makeError("CLOSED", reason || `connection closed (${code})`));
        this.emit("disconnected", { code, reason, wasConnected, byUser: this.closedByUser });
      });
    });
  }

  close(): void {
    this.closedByUser = true;
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close(1000, "client closing");
    } catch {
      ws.terminate();
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.hello) {
      return Promise.reject(this.makeError("NOT_CONNECTED", "not connected to the gateway"));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.makeError("TIMEOUT", `${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private handleFrame(frame: any): void {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "res") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(this.errorFromFrame(frame.error));
      return;
    }
    if (frame.type === "event") {
      this.emit("event", frame.event as string, frame.payload, frame);
      this.emit(`event:${frame.event}`, frame.payload, frame);
    }
  }

  private buildConnectParams(nonce: string, signedAtMs: number): Record<string, unknown> {
    // operator.admin is needed for chat.send originating-route fields (mirroring quick-chat replies to the chat app).
    const scopes = this.opts.scopes ?? ["operator.read", "operator.write", "operator.admin"];
    const { platform, deviceFamily } = platformIdentity(this.opts.platform);
    const token = this.opts.token?.trim() || undefined;
    const password = this.opts.password?.trim() || undefined;
    const auth: Record<string, string> = {};
    if (token) auth.token = token;
    if (password) auth.password = password;
    const identity = this.opts.identity;
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: "operator",
      scopes,
      signedAtMs,
      token: token ?? null,
      nonce,
      platform,
      deviceFamily,
    });
    return {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: CLIENT_ID,
        displayName: CLIENT_DISPLAY_NAME,
        version: this.opts.clientVersion,
        platform,
        deviceFamily,
        mode: CLIENT_MODE,
      },
      role: "operator",
      scopes,
      caps: this.opts.caps ?? ["tool-events"],
      auth: Object.keys(auth).length ? auth : undefined,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      userAgent: `openclaw-pet/${this.opts.clientVersion}`,
      device: {
        id: identity.deviceId,
        publicKey: publicKeyBase64Url(identity.publicKeyPem),
        signature: signPayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce,
      },
    };
  }

  private errorFromFrame(error: any): GatewayError {
    const err = this.makeError(
      typeof error?.code === "string" ? error.code : "UNKNOWN",
      typeof error?.message === "string" ? error.message : "gateway request failed",
    );
    if (error?.details && typeof error.details === "object") {
      err.details = error.details;
      if (typeof error.details.code === "string") err.detailCode = error.details.code;
    }
    if (typeof error?.retryable === "boolean") err.retryable = error.retryable;
    return err;
  }

  private makeError(code: string, message: string): GatewayError {
    const err = new Error(message) as GatewayError;
    err.code = code;
    return err;
  }
}
