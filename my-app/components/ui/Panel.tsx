import type { HTMLAttributes } from "react";

/** Flat surface, radius 12, no shadow. Used for diff/SQL/timeline containers. */
export function Panel({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={["panel", className].filter(Boolean).join(" ")} {...props} />;
}
