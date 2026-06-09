import type { HTMLAttributes, ReactNode } from "react";

/** The vertical spine that lineage nodes hang off of. */
export function Timeline({ className = "", children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={["relative", className].filter(Boolean).join(" ")} {...props}>
      <div className="tl-rail" />
      {children}
    </div>
  );
}

type NodeState = "applied" | "pending";

type TimelineNodeProps = HTMLAttributes<HTMLDivElement> & {
  state: NodeState;
  /** Mark this node as the current HEAD (adds a brand halo). */
  head?: boolean;
  /** Mark HEAD as drifted (amber dot). Implies head styling. */
  drift?: boolean;
  children: ReactNode;
};

/** One migration on the lineage spine. */
export function TimelineNode({
  state,
  head = false,
  drift = false,
  className = "",
  children,
  ...props
}: TimelineNodeProps) {
  const classes = [
    "tl-node",
    state,
    head || drift ? "head" : "",
    drift ? "drift-head" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} {...props}>
      <div className="dot" />
      {children}
    </div>
  );
}
