"use client";

import { useEffect, useState } from "react";
import { useUser } from "@/hooks/useUser";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";

type UserProfile = {
  id: number;
  email: string;
  role: string;
};

export default function AdminControlPage() {
  const { isAdmin, loading: roleLoading, user: currentUser } = useUser();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  useEffect(() => {
    if (isAdmin) {
      fetchUsers();
    }
  }, [isAdmin]);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users");
      const data = await res.json();
      setUsers(data.users || []);
    } catch (error) {
      console.error("Failed to fetch users");
    }
    setLoading(false);
  };

  const updateRole = async (userId: number, newRole: string) => {
    setUpdating(userId);
    try {
      await fetch("/api/admin/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: newRole }),
      });
      setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
    } catch (error) {
      console.error("Failed to update role");
    }
    setUpdating(null);
  };

  const deleteUser = async (userId: number, userEmail: string) => {
    if (currentUser?.email === userEmail) {
      alert("You cannot delete your own account.");
      return;
    }
    if (!confirm(`Are you sure you want to delete ${userEmail}?`)) return;
    
    setDeleting(userId);
    try {
      await fetch("/api/admin/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      await fetchUsers();
    } catch (error) {
      console.error("Failed to delete user");
    }
    setDeleting(null);
  };

  if (roleLoading) return <div className="loading-state">Loading...</div>;
  if (!isAdmin) return <div className="access-denied">Access denied. Admins only.</div>;

  return (
      <div className="db-layout">
        <Sidebar current="Admin Control" />
        <main className="db-main">
          <Topbar title="Admin Control" text="Manage user roles and permissions." />
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
                      <th>Actions</th>
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
                          {updating === user.id && <span className="admin-updating">Updating...</span>}
                        </td>
                        <td>
                          <button
                            onClick={() => deleteUser(user.id, user.email)}
                            disabled={deleting === user.id || currentUser?.email === user.email}
                            className="admin-delete-btn"
                          >
                            {deleting === user.id ? "..." : "Delete"}
                          </button>
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