import { ChevronRightIcon } from "@/components/ui/icons";

type StudioTopbarProps = {
  /** Current screen name, shown after "Workspace ›" in the breadcrumb. */
  breadcrumbScreen: string;
};

/**
 * Top chrome: a breadcrumb that reflects the active screen. Each screen exposes
 * its own working actions in the page body (Add connection, Compare, Deploy, …),
 * so the top bar stays intentionally minimal rather than carrying duplicate or
 * not-yet-wired shortcuts.
 */
export function StudioTopbar({ breadcrumbScreen }: StudioTopbarProps) {
  return (
    <div
      className="h-14 px-5 flex items-center gap-4 flex-none"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}
    >
      {/* Breadcrumb — reflects the active route */}
      <nav className="flex items-center gap-2 text-[13px]" style={{ color: "var(--text-2)" }}>
        <span style={{ color: "var(--text-3)" }}>Workspace</span>
        <ChevronRightIcon size={12} />
        <span className="font-medium" style={{ color: "var(--text)" }}>
          {breadcrumbScreen}
        </span>
      </nav>
    </div>
  );
}
