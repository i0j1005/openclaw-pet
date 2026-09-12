import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutcome, extractMessageText } from "../dist/tests/reactions.js";

const final = (text) => classifyOutcome({ state: "final", text });

test("errors always map to error", () => {
  assert.equal(classifyOutcome({ state: "error", text: "Done!" }), "error");
});

test("aborted runs produce no reaction", () => {
  assert.equal(classifyOutcome({ state: "aborted", text: "whatever" }), null);
});

test("questions win over success words", () => {
  assert.equal(final("I finished the refactor. Should I also update the tests?"), "question");
  assert.equal(final("두 가지 방법이 있어요.\n어떤 걸로 할까요?"), "question");
});

test("success phrases map to happy", () => {
  assert.equal(final("✅ All tests passed and the fix is deployed."), "happy");
  assert.equal(final("요청하신 작업을 완료했습니다."), "happy");
});

test("failure phrases in the reply map to error", () => {
  assert.equal(final("❌ The build failed: missing module."), "error");
  assert.equal(final("빌드가 실패했어요. 로그를 확인해주세요."), "error");
});

test("neutral replies map to no reaction", () => {
  assert.equal(final("Paris is the capital of France."), null);
  assert.equal(final("파리는 프랑스의 수도입니다."), null);
});

test("observer hints override text", () => {
  assert.equal(classifyOutcome({ state: "final", text: "ok", observerHealth: "waiting-on-user" }), "question");
});

// ---- new emotions ---------------------------------------------------------------

test("praise: the assistant compliments the user (EN + KO)", () => {
  assert.equal(final("Great question! The difference is that async functions always return a promise."), "praise");
  assert.equal(final("Nice catch, you're absolutely right about the off-by-one."), "praise");
  assert.equal(final("좋은 질문이에요! 비동기 함수는 항상 프로미스를 반환합니다."), "praise");
  assert.equal(final("정말 잘하셨어요. 그 접근이 맞습니다."), "praise");
});

test("praise beats a generic done in the same reply", () => {
  assert.equal(final("Great idea. I applied it and the tests are green, all done."), "praise");
});

test("encourage: the assistant cheers the user on (EN + KO)", () => {
  assert.equal(final("You've got this. Keep going, the last step is the easiest."), "encourage");
  assert.equal(final("Don't give up, you're almost there!"), "encourage");
  assert.equal(final("화이팅! 조금만 더 하면 됩니다."), "encourage");
  assert.equal(final("힘내세요, 충분히 할 수 있어요."), "encourage");
});

test("shy: bashful replies (EN + KO)", () => {
  assert.equal(final("Aw, you're making me blush. Thanks!"), "shy");
  assert.equal(final("*blushes* That's very kind of you."), "shy");
  assert.equal(final("칭찬해 주시니 부끄럽네요 😳"), "shy");
  assert.equal(final("과찬이십니다, 쑥스럽네요."), "shy");
});

test("sad: bad news or sympathy (EN + KO)", () => {
  assert.equal(final("I'm sorry to hear that. Losing a pet is really hard."), "sad");
  assert.equal(final("Unfortunately that API was discontinued last year, so there is no replacement."), "sad");
  assert.equal(final("안타깝게도 그 기능은 더 이상 지원하지 않습니다."), "sad");
  assert.equal(final("정말 슬픈 소식이네요. 마음이 아픕니다 😢"), "sad");
});

test("sad does not swallow failures or questions", () => {
  assert.equal(final("Unfortunately the build failed again."), "error");
  assert.equal(final("Unfortunately not. Do you want me to try another approach?"), "question");
});

test("tired: worn-out replies (EN + KO)", () => {
  assert.equal(final("Phew, that was a lot of files. Everything is migrated now."), "tired");
  assert.equal(final("I'm exhausted after that refactor, but it works."), "tired");
  assert.equal(final("휴… 정말 힘들었어요. 그래도 다 옮겼습니다."), "tired");
  assert.equal(final("긴 작업이라 조금 지쳤네요 😮‍💨"), "tired");
});

test("plain sentences with the new keywords as questions still ask", () => {
  assert.equal(final("Are you tired of the current layout?"), "question");
  assert.equal(final("부끄러우세요?"), "question");
});

test("extractMessageText handles strings and content blocks", () => {
  assert.equal(extractMessageText("hi"), "hi");
  assert.equal(extractMessageText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(extractMessageText(null), "");
});
