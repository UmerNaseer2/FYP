import type { ReactNode } from "react";

type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Action buttons / pills shown beneath the copy. */
  actions?: ReactNode;
  /**
   * "brand" for an ordinary empty list, "break" when the state is a failure.
   * Without this every failure was drawn in the same friendly blue as
   * "Nothing tracked yet", so a load error read as an empty list.
   */
  tone?: "brand" | "break";
};

/** Centered placeholder for empty content areas (and the empty shell). */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  tone = "brand",
}: EmptyStateProps) {
  return (
    <div className="grid place-items-center h-full w-full" style={{ background: "var(--bg)" }}>
      <div className="text-center max-w-[420px] px-6 py-12">
        {icon && (
          <div
            className="mx-auto w-12 h-12 rounded-2xl grid place-items-center mb-4"
            style={{
              background: tone === "break" ? "var(--break-soft)" : "var(--brand-soft)",
              color: tone === "break" ? "var(--break)" : "var(--brand)",
            }}
          >
            {icon}
          </div>
        )}
        <h3 className="text-[18px] font-semibold tracking-[-0.01em]">{title}</h3>
        {description && (
          <p className="text-[13.5px] mt-2" style={{ color: "var(--text-2)" }}>
            {description}
          </p>
        )}
        {actions && <div className="mt-5 flex items-center justify-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
