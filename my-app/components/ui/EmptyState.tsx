import type { ReactNode } from "react";

type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Action buttons / pills shown beneath the copy. */
  actions?: ReactNode;
};

/** Centered placeholder for empty content areas (and the empty shell). */
export function EmptyState({ icon, title, description, actions }: EmptyStateProps) {
  return (
    <div className="grid place-items-center h-full w-full" style={{ background: "var(--bg)" }}>
      <div className="text-center max-w-[420px] px-6 py-12">
        {icon && (
          <div
            className="mx-auto w-12 h-12 rounded-2xl grid place-items-center mb-4"
            style={{ background: "var(--brand-soft)", color: "var(--brand)" }}
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
