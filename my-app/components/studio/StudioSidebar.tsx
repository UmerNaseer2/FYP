import Link from "next/link";
import { Pill } from "@/components/ui";
import { LogoIcon, ChevronLeftIcon, SunIcon, MoonIcon, SignOutIcon } from "@/components/ui/icons";
import type { NavItem } from "./nav";

export type StudioUser = {
  name: string;
  email: string;
  initials: string;
};

type StudioSidebarProps = {
  items: NavItem[];
  activeHref: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  user: StudioUser;
  onSignOut: () => void;
};

export function StudioSidebar({
  items,
  activeHref,
  collapsed,
  onToggleCollapse,
  theme,
  onToggleTheme,
  user,
  onSignOut,
}: StudioSidebarProps) {
  // When collapsed, hide every label-bearing element (the `sb-label` pattern).
  const labelHidden = collapsed ? "hidden" : "";

  return (
    <aside
      className="flex flex-col"
      style={{ background: "var(--surface)", borderRight: "1px solid var(--border)" }}
    >
      {/* Brand + collapse */}
      <div
        className="h-14 px-4 flex items-center gap-2.5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div
          className="w-7 h-7 rounded-lg grid place-items-center flex-none"
          style={{ background: "var(--brand)", color: "#fff" }}
        >
          <LogoIcon size={15} />
        </div>
        <div className={`leading-tight ${labelHidden}`}>
          <div className="font-semibold text-[13.5px]">Schema Studio</div>
          <div className="text-[11px] mono" style={{ color: "var(--text-3)" }}>
            v2.0.0
          </div>
        </div>
        <button
          className="ml-auto btn btn-ghost btn-sm"
          title={collapsed ? "Expand" : "Collapse"}
          onClick={onToggleCollapse}
        >
          <ChevronLeftIcon size={14} style={{ transform: collapsed ? "rotate(180deg)" : undefined }} />
        </button>
      </div>

      {/* Nav */}
      <div className="p-3">
        <div className={`section-title px-2 mb-1 ${labelHidden}`}>Workspace</div>
        <div className="space-y-0.5">
          {items.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item ${active ? "active" : ""}`}
                title={item.label}
              >
                {item.icon}
                <span className={labelHidden}>{item.label}</span>
                {item.badge && (
                  <Pill tone="drift" dot={false} className={`badge !text-[10px] !py-0 ${labelHidden}`}>
                    {item.badge}
                  </Pill>
                )}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Footer: theme toggle + identity */}
      <div className="mt-auto p-3 space-y-2" style={{ borderTop: "1px solid var(--border)" }}>
        <button className="nav-item w-full" onClick={onToggleTheme}>
          {theme === "dark" ? <SunIcon className="ico" /> : <MoonIcon className="ico" />}
          <span className={labelHidden}>Theme</span>
          <span className={`ml-auto text-[11px] ${labelHidden}`} style={{ color: "var(--text-3)" }}>
            {theme === "dark" ? "Dark" : "Light"}
          </span>
        </button>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <div
            className="w-7 h-7 rounded-full grid place-items-center flex-none text-white text-[11px] font-semibold"
            style={{ background: "linear-gradient(135deg, var(--brand), #a78bfa)" }}
          >
            {user.initials}
          </div>
          <div className={`leading-tight min-w-0 ${labelHidden}`}>
            <div className="text-[12.5px] font-medium truncate">{user.name}</div>
            <div className="text-[11px] mono truncate" style={{ color: "var(--text-3)" }}>
              {user.email}
            </div>
          </div>
          <button
            className={`ml-auto btn btn-ghost btn-sm ${labelHidden}`}
            title="Sign out"
            onClick={onSignOut}
          >
            <SignOutIcon size={13} />
          </button>
        </div>
      </div>
    </aside>
  );
}
