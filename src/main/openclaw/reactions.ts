// Local, token-free heuristics that turn a finished OpenClaw run into a pet reaction.
// Nothing here talks to a model; it only looks at metadata and the reply text.
// Korean and English phrases are covered; everything is a plain regex.
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

/** The assistant compliments the user. */
const PRAISE_PATTERNS: RegExp[] = [
  /\b(great|good|excellent|smart|brilliant|clever|nice|fantastic|wonderful) (question|idea|catch|point|thinking|call|work|job|choice|instinct|eye)\b/i,
  /\b(well done|nicely done|good job|great job|you (nailed|crushed|got) it|you'?re (absolutely )?right|spot on|impressive|kudos|proud of you|you did (great|well|it))\b/i,
  /(잘하셨|잘 하셨|잘했어|훌륭|멋진 (생각|질문|선택|아이디어)|좋은 (질문|생각|선택|아이디어|지적|포인트)|정확히 (보셨|짚으셨)|대단하|최고예요|최고입니다|굿잡)/,
  /(👏|🙌|💯)/,
];

/** The assistant cheers the user on. */
const ENCOURAGE_PATTERNS: RegExp[] = [
  /\b(you can do (it|this)|you'?ve got this|keep (going|it up|at it)|don'?t give up|hang in there|you'?re (almost|nearly) there|cheering (you|for you)|rooting for you|good luck|go for it|almost there|one step at a time|believe in you)\b/i,
  /(화이팅|파이팅|힘내|힘내세요|힘내요|응원|할 수 있어|할 수 있습니다|해낼 수 있|포기하지|조금만 더|거의 다 왔|잘 될 거예요|잘될 거예요|잘 될 겁니다)/,
  /(💪|🔥|🍀)/,
];

/** Bashful / embarrassed. */
const SHY_PATTERNS: RegExp[] = [
  /\b(blush(es|ing)?|embarrass(ed|ing)|bashful|shy|flattered|you'?re making me blush|aw+,? shucks|too kind)\b/i,
  /\*(blushes|blushing|hides|shy)\*/i,
  /(부끄럽|부끄러워|쑥스럽|쑥스러워|민망|수줍|과찬|몸 둘 바|헤헤)/,
  /(😳|🙈|☺️|😊|🫣)/,
];

/** Bad or sad news, sympathy. */
const SAD_PATTERNS: RegExp[] = [
  /\b(sorry (to hear|for your loss)|my condolences|that'?s (really |so |very )?(sad|unfortunate|heartbreaking|rough|tough)|unfortunately|sadly|regrettably|i wish i could|i'?m afraid (that|there|it|we|i)|what a pity|that'?s a shame|not possible|no longer available|discontinued)\b/i,
  /(슬프|슬퍼|안타깝|유감|아쉽|속상|마음이 아프|안 됐|안됐|힘든 소식|아쉽게도|안타깝게도|유감스럽게도|불가능합니다|지원하지 않)/,
  /(😢|😭|😞|😔|💔|🥲)/,
];

/** Worn out after a big task. */
const TIRED_PATTERNS: RegExp[] = [
  /\b(phew|whew|i'?m (exhausted|tired|worn out|beat|drained|wiped)|that was (a lot|exhausting|a big one|a long one|intense|a marathon)|long day|need a (break|nap|rest)|so tired|exhausting)\b/i,
  /(힘들었|힘드네|힘들다|힘들어|지쳤|지치네|피곤|기진맥진|녹초|휴…|휴\.\.\.|후…|후\.\.\.|쉬어야|한숨 돌|고생했|고생 많|힘든 작업이었)/,
  /(😮‍💨|😩|😫|🥱|😪|😴|💤)/,
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

function matchesAny(patterns: RegExp[], ...parts: string[]): boolean {
  return patterns.some((re) => parts.some((p) => re.test(p)));
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
  const tailWindow = text.slice(-400);

  // A literal question at the end needs the user, so it wins over everything else.
  if (/\?\s*$/.test(tail)) return "question";
  if (STRONG_ERROR_PATTERNS.some((re) => re.test(head))) return "error";
  if (QUESTION_PATTERNS.some((re) => re.test(tail) || re.test(tailWindow))) return "question";
  if (ERROR_PATTERNS.some((re) => re.test(head) || re.test(tail))) return "error";

  // Emotional colour, most specific first. A bashful reply usually follows a compliment from the user,
  // so shy is checked before praise; praise/encouragement are about the user and beat a generic "done".
  if (matchesAny(SHY_PATTERNS, head, tail)) return "shy";
  if (matchesAny(PRAISE_PATTERNS, head, tail)) return "praise";
  if (matchesAny(ENCOURAGE_PATTERNS, head, tail)) return "encourage";
  if (matchesAny(TIRED_PATTERNS, head, tail)) return "tired";
  if (matchesAny(SAD_PATTERNS, head, tail)) return "sad";
  if (matchesAny(HAPPY_PATTERNS, tail, head)) return "happy";
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
