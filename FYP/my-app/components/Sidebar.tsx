import Link from "next/link";

export default function Sidebar({ current }: { current: string }) {
  const links = [
    { name: "Dashboard", href: "/" },
    { name: "Connections", href: "/connections" },
    { name: "Schema Comparison", href: "/compare" },
    { name: "Version Detection", href: "/versions" },
    { name: "SQL Scripts", href: "/scripts" },
  ];

  return (
    <aside className="db-sidebar">
      <div className="db-sidebar__header">
        <div className="db-sidebar__title">DB Schema Control</div>
        <div className="db-sidebar__subtitle">Schema comparison demo</div>
      </div>

      <nav className="db-sidebar__nav">
        {links.map((link) => (
          <Link
            key={link.name}
            href={link.href}
            className={`db-sidebar__link ${
              current === link.name ? "db-sidebar__link--active" : ""
            }`}
          >
            {link.name}
          </Link>
        ))}
      </nav>

      <div className="db-sidebar__footer">v1.0.0</div>
    </aside>
  );
}