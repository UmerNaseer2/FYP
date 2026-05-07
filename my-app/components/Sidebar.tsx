"use client";

import Link from "next/link";
import { useUser } from "@/hooks/useUser";

export default function Sidebar({ current }: { current: string }) {
  const { isAdmin, loading } = useUser();

  const links = [
    { name: "Dashboard", href: "/" },
    { name: "Connections", href: "/connections" },
    { name: "Schema Comparison", href: "/compare" },
    { name: "Version Detection", href: "/versions" },
    { name: "SQL Scripts", href: "/scripts" },
  ];

  return (
    <aside className="db-sidebar">
      <div className="db-sidebar__title">DB Schema Control</div>
      <div className="db-sidebar__subtitle">Schema comparison demo</div>

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
        {!loading && isAdmin && (
          <Link
            href="/adminControl"
            className={`db-sidebar__link ${
              current === "Admin Control" ? "db-sidebar__link--active" : ""
            }`}
          >
            Admin Control
          </Link>
        )}
      </nav>
    </aside>
  );
}