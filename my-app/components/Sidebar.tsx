"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { createClient } from "@/lib/supabase/client";

export default function Sidebar({ current }: { current: string }) {
  const { user, isAdmin, role, loading } = useUser();
  const supabase = createClient();
  const router = useRouter();

  const links = [
    { name: "Dashboard", href: "/" },
    { name: "Connections", href: "/connections" },
    { name: "Schema Comparison", href: "/compare" },
  ];

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  if (loading) {
    return (
      <aside className="db-sidebar">
        <div className="db-sidebar__title">DB Schema Control</div>
        <div className="db-sidebar__subtitle">Loading...</div>
      </aside>
    );
  }

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

      {user && (
        <div className="db-sidebar__user-section">
          <div className={`db-sidebar__user-role db-sidebar__user-role--${role}`}>
            {role === "admin" ? "👑 Admin" : "👁️ Viewer"}
          </div>
          <div className="db-sidebar__user-email">{user.email}</div>
          <button onClick={handleLogout} className="db-sidebar__logout-btn">
            Logout
          </button>
        </div>
      )}
    </aside>
  );
}