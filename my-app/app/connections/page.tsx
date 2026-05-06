"use client";

import { useEffect, useState } from "react";
import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

type Connection = {
  id: number;
  name: string;
  host: string;
  port: number;
  type: string;
  username: string;
};

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  const [form, setForm] = useState({
    name: "",
    host: "localhost",
    port: "5432",
    type: "PostgreSQL",
    username: "postgres",
    password: "",
  });

  const safeJson = async (res: Response) => {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };

  const fetchConnections = async () => {
    try {
      const res = await fetch("/api/connections", {
        cache: "no-store",
      });

      const data = await safeJson(res);

      if (Array.isArray(data)) {
        setConnections(data);
      } else {
        setConnections([]);
        setMessage(data.error || "Failed to load connections.");
      }
    } catch (error) {
      console.error("Fetch error:", error);
      setConnections([]);
      setMessage("Failed to load connections.");
    }
  };

  useEffect(() => {
    fetchConnections();
  }, []);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    setForm({
      ...form,
      [e.target.name]: e.target.value,
    });
  };

  const resetForm = () => {
    setEditingId(null);
    setForm({
      name: "",
      host: "localhost",
      port: "5432",
      type: "PostgreSQL",
      username: "postgres",
      password: "",
    });
  };

  const handleSave = async () => {
    setMessage("");

    const method = editingId ? "PUT" : "POST";
    const body = editingId ? { id: editingId, ...form } : form;

    try {
      const res = await fetch("/api/connections", {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await safeJson(res);

      if (!res.ok) {
        setMessage(data.error || "Failed to save connection.");
        return;
      }

      setMessage(
        editingId
          ? "Connection updated successfully."
          : "Connection saved successfully."
      );

      resetForm();
      fetchConnections();
    } catch (error) {
      console.error("Save error:", error);
      setMessage("Failed to save connection.");
    }
  };

  const handleTestConnection = async () => {
    setMessage("Testing connection...");

    try {
      const res = await fetch("/api/connections/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          host: form.host,
          port: form.port,
          type: form.type,
          username: form.username,
          password: form.password,
          database: "postgres",
        }),
      });

      const data = await safeJson(res);

      if (!res.ok) {
        setMessage(data.error || "Connection failed.");
        return;
      }

      setMessage("Connection successful.");
    } catch (error) {
      console.error("Test error:", error);
      setMessage("Connection failed.");
    }
  };

  const handleEdit = (conn: Connection) => {
    setEditingId(conn.id);
    setForm({
      name: conn.name,
      host: conn.host,
      port: String(conn.port),
      type: conn.type,
      username: conn.username,
      password: "",
    });

    setMessage("Please enter password again before updating.");
  };

  const handleDelete = async (id: number) => {
    const confirmDelete = confirm("Are you sure you want to delete this?");
    if (!confirmDelete) return;

    try {
      const res = await fetch("/api/connections", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await safeJson(res);

      if (!res.ok) {
        setMessage(data.error || "Failed to delete connection.");
        return;
      }

      setMessage("Connection deleted successfully.");
      fetchConnections();
    } catch (error) {
      console.error("Delete error:", error);
      setMessage("Failed to delete connection.");
    }
  };

  return (
    <div className="db-layout">
      <Sidebar current="Connections" />

      <main className="db-main">
        <Topbar
          title="Connections"
          text="Add and manage database connections."
        />

        {message && <div className="conn-message">{message}</div>}

        <div className="conn-card">
          <h2 className="conn-card__title">
            {editingId ? "Edit Connection" : "Add Connection"}
          </h2>

          <div className="conn-form">
            <input
              name="name"
              value={form.name}
              onChange={handleChange}
              type="text"
              placeholder="Connection Name"
              className="conn-input"
            />

            <input
              name="host"
              value={form.host}
              onChange={handleChange}
              type="text"
              placeholder="Host"
              className="conn-input"
            />

            <div className="conn-row">
              <input
                name="port"
                value={form.port}
                onChange={handleChange}
                type="text"
                placeholder="Port"
                className="conn-input"
              />

              <select
                name="type"
                value={form.type}
                onChange={handleChange}
                className="conn-select"
              >
                <option value="PostgreSQL">PostgreSQL</option>
                <option value="MySQL">MySQL</option>
                <option value="SQL Server">SQL Server</option>
              </select>
            </div>

            <input
              name="username"
              value={form.username}
              onChange={handleChange}
              type="text"
              placeholder="Username"
              className="conn-input"
            />

            <input
              name="password"
              value={form.password}
              onChange={handleChange}
              type="password"
              placeholder="Password"
              className="conn-input"
            />

            <div className="conn-btn-group">
              <button
                className="conn-btn conn-btn--secondary"
                type="button"
                onClick={handleTestConnection}
              >
                Test Connection
              </button>

              <button
                className="conn-btn conn-btn--primary"
                type="button"
                onClick={handleSave}
              >
                {editingId ? "Update" : "Save"}
              </button>

              {editingId && (
                <button
                  className="conn-btn conn-btn--secondary"
                  type="button"
                  onClick={resetForm}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="conn-card">
          <h2 className="conn-card__title">Saved Connections</h2>

          <table className="conn-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Host</th>
                <th>Username</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {connections.length === 0 ? (
                <tr>
                  <td colSpan={5}>No connections saved yet.</td>
                </tr>
              ) : (
                connections.map((conn) => (
                  <tr key={conn.id}>
                    <td>{conn.name}</td>
                    <td>{conn.type}</td>
                    <td>
                      {conn.host}:{conn.port}
                    </td>
                    <td>{conn.username}</td>
                    <td>
                      <button
                        className="conn-edit-btn"
                        type="button"
                        onClick={() => handleEdit(conn)}
                      >
                        Edit
                      </button>

                      <button
                        className="conn-delete-btn"
                        type="button"
                        onClick={() => handleDelete(conn.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}