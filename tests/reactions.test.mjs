import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutcome, extractMessageText } from "../dist/tests/reactions.js";

test("errors always map to error", () => {
  assert.equal(classifyOutcome({ state: "error", text: "Done!" }), "error");
});

test("aborted runs produce no reaction", () => {
  assert.equal(classifyOutcome({ state: "aborted", text: "whatever" }), null);
});

test("questions win over success words", () => {
  assert.equal(classifyOutcome({ state: "final", text: "I finished the refactor. Should I also update the tests?" }), "question");
  assert.equal(classifyOutcome({ state: "final", text: "두 가지 방법이 있어요.\n어떤 걸로 할까요?" }), "question");
});

test("success phrases map to happy", () => {
  assert.equal(classifyOutcome({ state: "final", text: "✅ All tests passed and the fix is deployed." }), "happy");
  assert.equal(classifyOutcome({ state: "final", text: "요청하신 작업을 완료했습니다." }), "happy");
});

test("failure phrases in the reply map to error", () => {
  assert.equal(classifyOutcome({ state: "final", text: "❌ The build failed: missing module." }), "error");
  assert.equal(classifyOutcome({ state: "final", text: "빌드가 실패했어요. 로그를 확인해주세요." }), "error");
});

test("neutral replies map to no reaction", () => {
  assert.equal(classifyOutcome({ state: "final", text: "Paris is the capital of France." }), null);
});

test("observer hints override text", () => {
  assert.equal(classifyOutcome({ state: "final", text: "ok", observerHealth: "waiting-on-user" }), "question");
});

test("extractMessageText handles strings and content blocks", () => {
  assert.equal(extractMessageText("hi"), "hi");
  assert.equal(extractMessageText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(extractMessageText(null), "");
});
