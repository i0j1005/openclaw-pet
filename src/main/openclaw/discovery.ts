// Finds a local OpenClaw Gateway without asking the user for anything.
//
// OpenClaw keeps its config at ~/.openclaw/openclaw.json (JSON5) unless
// OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR override it. The file contains the
// gateway port and the shared auth token, which is exactly what a same-host
// client needs. We only ever *read* it.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";

export interface DiscoveredGateway {
  url: string;
  token?: string;
  password?: string;
  authMode: "none" | "token" | "password" | "trusted-proxy" | "unknown";
  configPath?: string;
  /** Human-readable reason when discovery is partial (e.g. secret stored as a SecretRef). */
  note?: string;
}

export const DEFAULT_GATEWAY_PORT = 18789;

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return expandHome(override);
  return join(homedir(), ".openclaw");
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) return expandHome(override);
  return join(resolveStateDir(env), "openclaw.json");
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Reads the local OpenClaw config and returns the loopback gateway endpoint.
 * Never throws: a missing or unreadable config yields the default loopback URL
 * with `authMode: "unknown"` so the caller can still probe the port.
 */
export function discoverLocalGateway(env: NodeJS.ProcessEnv = process.env): DiscoveredGateway {
  const configPath = resolveConfigPath(env);
  const fallback: DiscoveredGateway = {
    url: `ws://127.0.0.1:${DEFAULT_GATEWAY_PORT}`,
    authMode: "unknown",
  };
  if (!existsSync(configPath)) {
    return { ...fallback, note: "OpenClaw config not found; trying the default port." };
  }
  let cfg: any;
  try {
    cfg = JSON5.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    return { ...fallback, configPath, note: `Could not parse OpenClaw config: ${(err as Error).message}` };
  }
  const gateway = cfg?.gateway ?? {};
  const port = Number.isInteger(gateway.port) && gateway.port > 0 ? gateway.port : DEFAULT_GATEWAY_PORT;
  const auth = gateway.auth ?? {};
  const mode = readString(auth.mode) as DiscoveredGateway["authMode"] | undefined;
  const tls = Boolean(gateway.tls?.enabled);
  const result: DiscoveredGateway = {
    url: `${tls ? "wss" : "ws"}://127.0.0.1:${port}`,
    authMode: mode ?? (readString(auth.token) ? "token" : readString(auth.password) ? "password" : "unknown"),
    configPath,
  };
  const token = auth.token;
  const password = auth.password;
  if (typeof token === "string") result.token = readString(token);
  else if (token && typeof token === "object") {
    result.note = "The gateway token is stored as a secret reference. Paste it manually in Settings.";
  }
  if (typeof password === "string") result.password = readString(password);
  return result;
}
