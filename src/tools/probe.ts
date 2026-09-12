// Diagnostic CLI: `npm run probe` — connects to the local Gateway exactly like the app does,
// prints what it found, lists sessions, then (optionally) streams events for a few seconds.
// It never calls chat.send, so it costs no tokens.
import { join } from "node:path";
import { homedir } from "node:os";
import { discoverLocalGateway } from "../main/openclaw/discovery";
import { loadOrCreateDeviceIdentity } from "../main/openclaw/device-identity";
import { GatewayClient } from "../main/openclaw/gateway-client";

const watchSeconds = Number(process.argv.find((a) => a.startsWith("--watch="))?.split("=")[1] ?? "0");
const identityPath =
  process.env.OPENCLAW_PET_IDENTITY ??
  join(process.env.APPDATA || join(homedir(), process.platform === "darwin" ? "Library/Application Support" : ".config"), "openclaw-pet", "device-identity.json");

async function main(): Promise<void> {
  const found = discoverLocalGateway();
  console.log("config:", found.configPath ?? "(not found)");
  console.log("gateway:", found.url, `auth=${found.authMode}`, found.token ? "(token found)" : found.password ? "(password found)" : "(no secret)");
  if (found.note) console.log("note:", found.note);
  const identity = loadOrCreateDeviceIdentity(identityPath);
  console.log("device:", identity.deviceId.slice(0, 12) + "…", identityPath);

  const client = new GatewayClient({
    url: process.env.OPENCLAW_PET_URL ?? found.url,
    token: process.env.OPENCLAW_PET_TOKEN ?? found.token,
    password: found.password,
    identity,
    clientVersion: "probe",
    platform: process.platform,
    log: (m) => console.log("  ·", m),
  });
  try {
    const hello = await client.connect();
    console.log(`connected: gateway ${hello.server.version}, protocol ${hello.protocol}, role ${hello.auth.role}, scopes ${hello.auth.scopes.join(",")}`);
    console.log("events advertised:", hello.features.events.filter((e) => ["chat", "agent", "sessions.changed", "session.observer"].includes(e)).join(", "));
    const res = await client.request<any>("sessions.list", { limit: 8, sortBy: "lastInteractionAt", requireLastInteraction: true, configuredAgentsOnly: true });
    for (const s of res?.sessions ?? []) {
      console.log(`  session ${s.key}  agent=${s.agentId ?? "?"}  kind=${s.kind ?? "?"}  active=${s.hasActiveRun ?? "?"}  last=${s.lastInteractionAt ? new Date(s.lastInteractionAt).toISOString() : "-"}`);
    }
    // --agents: the roster the character "Agent" dropdown shows (agents.list, metadata-only).
    if (process.argv.includes("--agents")) {
      const a = await client.request<any>("agents.list", {});
      console.log(`agents (default ${a?.defaultId ?? "?"}): ${(a?.agents ?? []).length}`);
      for (const agent of a?.agents ?? []) {
        console.log(`  ${agent.id}  kind=${agent.kind ?? "-"}  name=${agent.identity?.name ?? agent.name ?? "-"}  emoji=${agent.identity?.emoji ?? "-"}`);
      }
    }
    // --history=<sessionKey>: print the last few transcript entries (metadata read, no tokens).
    const historyKey = process.argv.find((a) => a.startsWith("--history="))?.split("=")[1];
    if (historyKey) {
      const h = await client.request<any>("chat.history", { sessionKey: historyKey, limit: 6 });
      const msgs: any[] = h?.messages ?? h?.history ?? [];
      console.log(`history for ${historyKey}: ${msgs.length} entries (keys: ${Object.keys(h ?? {}).join(",")})`);
      for (const m of msgs.slice(-6)) {
        const content = Array.isArray(m?.content) ? m.content.map((b: any) => (b?.type === "text" ? b.text : `[${b?.type}]`)).join(" ") : String(m?.content ?? m?.text ?? "");
        console.log(`  ${m?.timestamp ? new Date(m.timestamp).toISOString() : "-"} ${m?.role ?? "?"}: ${content.replace(/\s+/g, " ").slice(0, 200)}`);
      }
    }
    if (watchSeconds > 0) {
      console.log(`watching events for ${watchSeconds}s…`);
      client.on("event", (event: string, payload: any) => {
        if (event === "tick" || event === "presence" || event === "health") return;
        const brief = payload && typeof payload === "object" ? JSON.stringify(payload).slice(0, 220) : String(payload);
        console.log(`  [${event}] ${brief}`);
      });
      await new Promise((r) => setTimeout(r, watchSeconds * 1000));
    }
  } catch (err: any) {
    console.error("FAILED:", err.code ?? "", err.detailCode ?? "", err.message);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

void main();
