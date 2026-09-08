/**
 * A toggle in a filter bar: the label, the number of rows behind it, and a
 * filled state when it is the active filter. Shared by Connections and the
 * dashboard so the two filter bars behave identically.
 */
export function FilterPill({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`pill ${active ? "pill-brand" : "pill-outline"}`}
      onClick={onClick}
      type="button"
      aria-pressed={active}
    >
      {active && <span className="dot" />}
      {children}
      <span className="mono ml-1" style={{ opacity: 0.7 }}>
        {count}
      </span>
    </button>
  );
}
