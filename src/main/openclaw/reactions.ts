// Local, token-free heuristics that turn a finished OpenClaw run into a pet reaction.
// Nothing here talks to a model; it only looks at metadata and the reply text.
import type { ReactionState } from "../../shared/types";

export interface RunOutcome {
  state: "final" | "error" | "aborted";
  text?: string;
  errorKind?: string;
  /** Optional `session.observer` health hint (`waiting-on-user`, `failed`, `done`, …). */
  observerHealth?: string;
}

const QUESTION_PATTERNS: RegExp[] = [
  /\b(would you like|do you want|should i|shall i|which (one|option)|let me know (if|which|what)|can you confirm|could you (confirm|clarify|tell me)|please (confirm|choose|specify|clarify|let me know)|what would you|how would you like)\b/i,
  /(할까요|드릴까요|해드릴까요|맞나요|인가요|일까요|건가요|괜찮을까요|원하시나요|원하세요|알려주세요|알려 주세요|선택해 ?주세요|어떻게 할까요|어느 (것|쪽))/,
];

/** Unambiguous failure openers: these beat soft question phrasing (but not a literal trailing "?"). */
const STRONG_ERROR_PATTERNS: RegExp[] = [
  /^(\s*)(❌|⛔|🚫|error\b|failed\b|failure\b|sorry,? i (can't|cannot|couldn't|was unable))/i,
  /^[\s\S]{0,80}?(실패했|오류가 발생|에러가 발생)/,
];

const ERROR_PATTERNS: RegExp[] = [
  /^(\s*)(❌|⛔|🚫|error\b|failed\b|failure\b|sorry,? i (can't|cannot|couldn't|was unable))/i,
  /\b(i (couldn't|could not|was unable to|wasn't able to|am unable to)|(command|build|test|tests|request|run) failed|an error occurred|exception|traceback|permission denied|not found)\b/i,
  /(실패했|오류가 발생|에러가 발생|할 수 없었|하지 못했|찾을 수 없)/,
];

const HAPPY_PATTERNS: RegExp[] = [
  /(✅|🎉|✔️|👍)/,
  /\b(done|all set|completed|complete|finished|fixed|success(ful|fully)?|passed|resolved|deployed|merged|created|updated|installed|ready)\b[.!]?/i,
  /(완료했|완료됐|완료되었|완료입니다|성공했|성공적으로|끝났|처리했|수정했|해결했|반영했|준비됐|추가했|생성했)/,
];

function lastMeaningfulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[`~]{3}/.test(l));
  return lines.length ? lines[lines.length - 1] : "";
}

export function classifyOutcome(outcome: RunOutcome): ReactionState {
  if (outcome.state === "aborted") return null;
  if (outcome.state === "error") return "error";
  if (outcome.observerHealth === "waiting-on-user") return "question";
  if (outcome.observerHealth === "failed") return "error";

  const text = (outcome.text ?? "").trim();
  if (!text) return null;
  const tail = lastMeaningfulLine(text);

  const head = text.slice(0, 300);
  // A literal question at the end needs the user, so it wins over everything else.
  if (/\?\s*$/.test(tail)) return "question";
  if (STRONG_ERROR_PATTERNS.some((re) => re.test(head))) return "error";
  if (QUESTION_PATTERNS.some((re) => re.test(tail) || re.test(text.slice(-400)))) return "question";
  if (ERROR_PATTERNS.some((re) => re.test(head) || re.test(tail))) return "error";
  if (HAPPY_PATTERNS.some((re) => re.test(tail) || re.test(head))) {
    return "happy";
  }
  return null;
}

/** Extracts plain text from an assistant message payload (string or content blocks). */
export function extractMessageText(message: unknown): string {
  if (!message) return "";
  if (typeof message === "string") return message;
  const m = message as { content?: unknown; text?: unknown };
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((block: any) => (block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
