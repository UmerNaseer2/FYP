"use client";

import { useEffect, useState } from "react";
import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

type Connection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  username: string;
  connection_string?: string;
};

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  const [form, setForm] = useState({
    name: "",
    host: "localhost",
    port: "5432",
    database_name: "postgres",
    type: "PostgreSQL",
    username: "postgres",
    password: "",
    connection_string: "",
  });

  const safeJson = async (res: Response) => {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };

  const fetchConnections = async () => {
    const res = await fetch("/api/connections", { cache: "no-store" });
    const data = await safeJson(res);

    if (Array.isArray(data)) {
      setConnections(data);
    } else {
      setConnections([]);
      setMessage(data.error || "Failed to load connections.");
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
      database_name: "postgres",
      type: "PostgreSQL",
      username: "postgres",
      password: "",
      connection_string: "",
    });
  };

  const handleSave = async () => {
    setMessage("");

    const method = editingId ? "PUT" : "POST";
    const body = editingId ? { id: editingId, ...form } : form;

    const res = await fetch("/api/connections", {
      method,
      headers: { "Content-Type": "application/json" },
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
  };

  const handleTestConnection = async () => {
    setMessage("Testing connection...");

    if (form.type !== "PostgreSQL") {
      setMessage(
        "Only PostgreSQL is supported now. MySQL and SQL Server are coming soon."
      );
      return;
    }

    const res = await fetch("/api/connections/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(form),
    });

    const data = await safeJson(res);

    if (!res.ok) {
      setMessage(data.error || "Connection failed.");
      return;
    }

    setMessage("Connection successful.");
  };

  const handleEdit = (conn: Connection) => {
    setEditingId(conn.id);

    setForm({
      name: conn.name,
      host: conn.host,
      port: String(conn.port),
      database_name: conn.database_name,
      type: conn.type,
      username: conn.username,
      password: "",
      connection_string: conn.connection_string || "",
    });

    setMessage("Enter password again before updating.");
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this connection?")) return;

    const res = await fetch("/api/connections", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id }),
    });

    const data = await safeJson(res);

    if (!res.ok) {
      setMessage(data.error || "Failed to delete.");
      return;
    }

    setMessage("Deleted successfully.");
    fetchConnections();
  };

  return (
    <div className="db-layout">
      <Sidebar current="Connections" />

      <main className="db-main">
        <Topbar title="Connections" text="Manage database connections" />

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
              placeholder="Connection Name"
              className="conn-input"
            />

            <input
              name="host"
              value={form.host}
              onChange={handleChange}
              placeholder="Host"
              className="conn-input"
            />

            <div className="conn-row">
              <input
                name="port"
                value={form.port}
                onChange={handleChange}
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
                <option value="MySQL" disabled>
                  MySQL (Coming Soon)
                </option>
                <option value="SQL Server" disabled>
                  SQL Server (Coming Soon)
                </option>
              </select>
            </div>

            <p className="conn-help-text">
              PostgreSQL is fully supported. Others coming soon.
            </p>

            <input
              name="database_name"
              value={form.database_name}
              onChange={handleChange}
              placeholder="Database Name"
              className="conn-input"
            />

            <input
              name="username"
              value={form.username}
              onChange={handleChange}
              placeholder="Username"
              className="conn-input"
            />

            <input
              name="password"
              value={form.password}
              onChange={handleChange}
              placeholder="Password"
              type="password"
              className="conn-input"
            />

            <input
              name="connection_string"
              value={form.connection_string}
              onChange={handleChange}
              placeholder="Connection String (optional)"
              className="conn-input"
            />

            <div className="conn-btn-group">
              <button
                className="conn-btn conn-btn--secondary"
                onClick={handleTestConnection}
              >
                Test Connection
              </button>

              <button
                className="conn-btn conn-btn--primary"
                onClick={handleSave}
              >
                {editingId ? "Update" : "Save"}
              </button>
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
                <th>Database</th>
                <th>Host</th>
                <th>User</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {connections.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.type}</td>
                  <td>{c.database_name}</td>
                  <td>
                    {c.host}:{c.port}
                  </td>
                  <td>{c.username}</td>
                  <td>
                    <button
                      className="conn-edit-btn"
                      onClick={() => handleEdit(c)}
                    >
                      Edit
                    </button>

                    <button
                      className="conn-delete-btn"
                      onClick={() => handleDelete(c.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}