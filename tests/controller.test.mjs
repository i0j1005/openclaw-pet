import test from "node:test";
import assert from "node:assert/strict";
import { OpenClawController } from "../dist/tests/controller.js";

function createController() {
  return new OpenClawController({
    identity: {
      deviceId: "test-device",
      publicKeyPem: "unused",
      privateKeyPem: "unused",
    },
    clientVersion: "test",
    platform: "test",
  });
}

test("identical snapshots are emitted only once", () => {
  const controller = createController();
  const snapshots = [];
  controller.on("snapshot", (snapshot) => snapshots.push(snapshot));

  controller.emitSnapshot();
  controller.emitSnapshot();
  assert.equal(snapshots.length, 1);

  controller.activeSessions.set("agent:main:main", Date.now());
  controller.emitSnapshot();
  controller.emitSnapshot();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].activity, "thinking");

  controller.dispose();
});

test("streaming chat text is coalesced and terminal states stay immediate", async () => {
  const controller = createController();
  const updates = [];
  controller.on("chatStatus", (update) => updates.push(update));

  controller.emitChatStatus({ runId: "run-1", phase: "thinking", text: "a" });
  controller.emitChatStatus({ runId: "run-1", phase: "thinking", text: "ab" });
  controller.emitChatStatus({ runId: "run-1", phase: "thinking", text: "abc" });
  assert.deepEqual(updates, []);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(updates, [{ runId: "run-1", phase: "thinking", text: "abc" }]);

  controller.emitChatStatus({ runId: "run-1", phase: "thinking", text: "obsolete" });
  controller.emitChatStatus({ runId: "run-1", phase: "reply", text: "done" });
  assert.deepEqual(updates.at(-1), { runId: "run-1", phase: "reply", text: "done" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(updates.length, 2);

  controller.dispose();
});

test("session and pending quick-chat tracking stay bounded", () => {
  const controller = createController();

  for (let i = 0; i < 150; i += 1) {
    controller.rememberSession({ key: `agent:main:session-${i}`, updatedAt: i });
  }
  assert.equal(controller.sessions.size, 100);
  assert.equal(controller.sessions.has("agent:main:session-0"), false);
  assert.equal(controller.sessions.has("agent:main:session-149"), true);

  controller.myRunIds.set("stale", { sessionKey: "agent:main:main", startedAt: 0 });
  controller.getSnapshot();
  assert.equal(controller.myRunIds.size, 0);

  controller.myRunIds.set("current", { sessionKey: "agent:main:main", startedAt: Date.now() });
  controller.dispose();
  assert.equal(controller.myRunIds.size, 0);
});

test("recent sessions can be listed and pinned within the selected agent", () => {
  const controller = createController();
  controller.rememberSession({ key: "agent:alpha:older", agentId: "alpha", kind: "direct", displayName: "Older chat", lastInteractionAt: 10 });
  controller.rememberSession({ key: "agent:alpha:newer", agentId: "alpha", kind: "thread", derivedTitle: "Newer chat", lastInteractionAt: 20 });
  controller.rememberSession({ key: "agent:beta:main", agentId: "beta", kind: "main", lastInteractionAt: 30 });
  controller.rememberSession({ key: "agent:alpha:cron:daily", agentId: "alpha", lastInteractionAt: 40 });

  controller.setTargetAgent("alpha");
  assert.deepEqual(controller.listSessions().map((session) => session.key), ["agent:alpha:newer", "agent:alpha:older"]);
  assert.equal(controller.pickTargetSession().key, "agent:alpha:newer");

  assert.deepEqual(controller.setTargetSession("agent:alpha:older"), { ok: true });
  assert.equal(controller.pickTargetSession().key, "agent:alpha:older");
  assert.equal(controller.listSessions().find((session) => session.key === "agent:alpha:older").selected, true);
  assert.equal(controller.setTargetSession("agent:beta:main").ok, false);

  controller.setTargetAgent("beta");
  assert.equal(controller.targetSessionKey, null);
  assert.equal(controller.pickTargetSession().key, "agent:beta:main");
  controller.dispose();
});

test("abortQuickChat sends the exact session and run to chat.abort", async () => {
  const controller = createController();
  const calls = [];
  controller.client = {
    connected: true,
    removeAllListeners: () => {},
    close: () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      return { ok: true, aborted: true, runIds: [params.runId] };
    },
  };
  controller.myRunIds.set("run-7", { sessionKey: "agent:main:main", startedAt: Date.now() });
  controller.runs.set("run-7", { sessionKey: "agent:main:main", startedAt: Date.now(), toolsRunning: 1, mine: true });
  controller.activeSessions.set("agent:main:main", Date.now());
  const statuses = [];
  controller.on("chatStatus", (status) => statuses.push(status));

  assert.deepEqual(await controller.abortQuickChat("run-7"), { ok: true });
  assert.deepEqual(calls, [{ method: "chat.abort", params: { sessionKey: "agent:main:main", runId: "run-7" } }]);
  assert.equal(controller.myRunIds.has("run-7"), false);
  assert.equal(controller.runs.has("run-7"), false);
  assert.deepEqual(statuses.at(-1), { runId: "run-7", phase: "aborted" });
  controller.dispose();
});
