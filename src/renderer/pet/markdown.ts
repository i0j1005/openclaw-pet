/**
 * Deliberately small Markdown renderer for chat replies. It recognizes only links, lists, inline
 * code and fenced code blocks; everything else becomes text nodes, so raw HTML cannot execute.
 */
export function renderLimitedMarkdown(container: HTMLElement, source: string): void {
  container.replaceChildren();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s*```([\w.+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      container.append(createCodeBlock(code.join("\n"), fence[1]));
      continue;
    }

    const listStart = /^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/.exec(line);
    if (listStart) {
      const ordered = Boolean(listStart[2]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = /^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/.exec(lines[index]);
        if (!item || Boolean(item[2]) !== ordered) break;
        const li = document.createElement("li");
        appendInline(li, item[3]);
        list.append(li);
        index += 1;
      }
      container.append(list);
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*```[\w.+-]*\s*$/.test(lines[index]) &&
      !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index++]);
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, paragraphLines.join(" "));
    container.append(paragraph);
  }
}

function appendInline(parent: HTMLElement, text: string): void {
  const token = /(`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const start = match.index ?? 0;
    if (start > cursor) parent.append(document.createTextNode(text.slice(cursor, start)));
    const value = match[0];
    if (value.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = value.slice(1, -1);
      parent.append(code);
    } else {
      const parsed = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(value);
      if (parsed && isSafeHttpUrl(parsed[2])) {
        const link = document.createElement("a");
        link.textContent = parsed[1];
        link.href = parsed[2];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      } else parent.append(document.createTextNode(value));
    }
    cursor = start + value.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function createCodeBlock(source: string, language: string): HTMLElement {
  const block = document.createElement("div");
  block.className = "code-block";
  const head = document.createElement("div");
  head.className = "code-head";
  const label = document.createElement("span");
  label.textContent = language || "Code";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy code";
  copy.title = "Copy this code block";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(source);
      copy.textContent = "Copied";
      window.setTimeout(() => (copy.textContent = "Copy code"), 1200);
    } catch {
      copy.textContent = "Copy failed";
      window.setTimeout(() => (copy.textContent = "Copy code"), 1600);
    }
  });
  head.append(label, copy);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.append(code);
  block.append(head, pre);
  return block;
}
