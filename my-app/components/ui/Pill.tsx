import type { HTMLAttributes } from "react";

export type PillTone = "sync" | "pending" | "drift" | "break" | "neutral" | "brand";

type PillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: PillTone;
  /** Show the leading status dot. Defaults to true. */
  dot?: boolean;
};

/** Status pill — the product's most-used component. Color carries meaning. */
export function Pill({
  tone = "neutral",
  dot = true,
  className = "",
  children,
  ...props
}: PillProps) {
  const classes = ["pill", `pill-${tone}`, className].filter(Boolean).join(" ");
  // Neutral dots read better as muted (text-3) than as the inherited text color.
  const dotStyle = tone === "neutral" ? { background: "var(--text-3)" } : undefined;
  return (
    <span className={classes} {...props}>
      {dot && <span className="dot" style={dotStyle} />}
      {children}
    </span>
  );
}
