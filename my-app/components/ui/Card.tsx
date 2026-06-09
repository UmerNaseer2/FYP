import type { HTMLAttributes } from "react";

/** Elevated surface, radius 14. Used for dashboard cards and grouped content. */
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={["card", className].filter(Boolean).join(" ")} {...props} />;
}
