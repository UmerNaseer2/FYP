import type { ReactNode } from "react";

/** Draws `**words**` in bold. The AI is asked for plain text, but models still slip into Markdown bold. */
function withBold(text: string, key: number): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={`${key}-${i}`}>{part}</span>
    )
  );
}

/** Writes `name` in backticks as code, the way the AI is asked to mark names (and, in a review's safer way, SQL). */
export function withNames(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="mono">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{withBold(part, i)}</span>
    )
  );
}
