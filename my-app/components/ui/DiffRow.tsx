import type { HTMLAttributes } from "react";

export type DiffKind = "add" | "rem" | "chg";

type DiffRowProps = HTMLAttributes<HTMLDivElement> & {
  kind: DiffKind;
};

const sign: Record<DiffKind, string> = {
  add: "+",
  rem: "−", // minus sign (−), wider than a hyphen
  chg: "~",
};

/** A single line in a diff. Color + left border encode add / remove / change. */
export function DiffRow({ kind, className = "", children, ...props }: DiffRowProps) {
  const classes = ["diff-row", `diff-${kind}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} {...props}>
      <span className="sign">{sign[kind]}</span>
      <span>{children}</span>
    </div>
  );
}
