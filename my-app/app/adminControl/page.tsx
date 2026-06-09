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
  const { isAdmin, loading: roleLoading, user: currentUser } = useUser();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, role")
      .order("email");
    if (!error && data) setUsers(data);
    setLoading(false);
  };

  useEffect(() => {
    if (isAdmin) {
      fetchUsers();
    }
    // We only want to (re)load the user list when the admin status flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

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

  const deleteUser = async (userId: string, userEmail: string) => {
    if (currentUser?.id === userId) {
      alert("You cannot delete your own account.");
      return;
    }

    const confirmed = confirm(`Are you sure you want to delete ${userEmail}? This action cannot be undone.`);
    if (!confirmed) return;

    setDeleting(userId);
    
    const { error: profileError } = await supabase
      .from("profiles")
      .delete()
      .eq("id", userId);
    
    if (profileError) {
      alert(`Error deleting user: ${profileError.message}`);
      setDeleting(null);
      return;
    }
    
    alert(`User ${userEmail} has been removed.`);
    await fetchUsers();
    setDeleting(null);
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
                        {updating === user.id && (
                          <span className="admin-updating">Updating...</span>
                        )}
                      </td>
                      <td>
                        <button
                          onClick={() => deleteUser(user.id, user.email)}
                          disabled={deleting === user.id || currentUser?.id === user.id}
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