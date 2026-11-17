import type { SVGProps } from "react";
import { statusLook, type StatusLook } from "@/lib/ui/status-look";

/**
 * The glyph for a state: a tick for in sync, a wave for drifted, a circle
 * with a mark for can't be reached, a dashed ring for not checked yet. Draw it
 * inside an <svg viewBox="0 0 24 24"> with a stroke, or use <StatusGlyph/>.
 */
export function StatusGlyphPaths({ glyph }: { glyph: StatusLook["glyph"] }) {
  switch (glyph) {
    case "check":
      return <path d="M5 12.5l4.5 4.5L19 7.5" />;
    case "wave":
      return <path d="M4 12c2.4-3.2 5-3.2 8 0s5.6 3.2 8 0" />;
    case "alert":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5v5.5" />
          <path d="M12 16.5h.01" />
        </>
      );
    default:
      return <circle cx="12" cy="12" r="7.5" strokeDasharray="3 3" />;
  }
}

type GlyphProps = { status: string | null | undefined; size?: number } & SVGProps<SVGSVGElement>;

/** The state's glyph on its own, in the current text colour. */
export function StatusGlyph({ status, size = 16, ...rest }: GlyphProps) {
  const look = statusLook(status);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <StatusGlyphPaths glyph={look.glyph} />
    </svg>
  );
}

type ChipProps = {
  /** "in_sync" | "drifted" | "unreachable", or null for not checked yet. */
  status: string | null | undefined;
  /** A different word, such as "3 drifted". Keep the state's own word in it. */
  label?: string;
  size?: "sm" | "md";
  /** "chip" (filled pill, the default) or "mark" (glyph and word, no fill, for list rows and legends). */
  variant?: "chip" | "mark";
  title?: string;
  className?: string;
};

/** A state as a chip: glyph, word and colour together, never colour alone. */
export function StatusChip({ status, label, size = "md", variant = "chip", title, className }: ChipProps) {
  const look = statusLook(status);
  const cls = [
    variant === "mark" ? "st-mark" : "st-chip",
    `st--${look.tone}`,
    size === "sm" ? "st-chip--sm" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} title={title ?? look.meaning} data-status={look.key}>
      <StatusGlyph status={look.key} size={size === "sm" ? 13 : 16} />
      {label ?? look.label}
    </span>
  );
}
