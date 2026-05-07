"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";

type Profile = {
  id: string;
  email: string;
  role: string;
};

export default function AdminControlPage() {
  const supabase = createClient();
  const { isAdmin, loading: roleLoading } = useUser();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin) {
      fetchUsers();
    }
  }, [isAdmin]);

  const fetchUsers = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, role")
      .order("email");
    if (!error && data) setUsers(data);
    setLoading(false);
  };

  const updateRole = async (userId: string, newRole: string) => {
    setUpdating(userId);
    const { error } = await supabase
      .from("profiles")
      .update({ role: newRole })
      .eq("id", userId);
    if (!error) {
      setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
    }
    setUpdating(null);
  };

  if (roleLoading) return <div className="loading-state">Checking permissions...</div>;
  if (!isAdmin) return <div className="access-denied">Access denied. Admins only.</div>;

  return (
    <div className="db-layout">
      <Sidebar current="Admin Control" />

      <main className="db-main">
        <Topbar
          title="Admin Control"
          text="Manage user roles and permissions."
        />

        <div className="admin-card">
          <h2 className="admin-card__title">User Role Management</h2>

          {loading ? (
            <div className="admin-loading">Loading users...</div>
          ) : (
            <div className="admin-table-wrapper">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Current Role</th>
                    <th>Change Role</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>
                        <span className={`role-badge role-badge--${user.role}`}>
                          {user.role}
                        </span>
                      </td>
                      <td>
                        <select
                          value={user.role}
                          onChange={(e) => updateRole(user.id, e.target.value)}
                          disabled={updating === user.id}
                          className="admin-select"
                        >
                          <option value="viewer">Viewer</option>
                          <option value="admin">Admin</option>
                        </select>
                        {updating === user.id && (
                          <span className="admin-updating">Updating...</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}