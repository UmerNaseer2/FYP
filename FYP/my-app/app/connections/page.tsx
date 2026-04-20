import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

export default function ConnectionsPage() {
  return (
    <div className="db-layout">
      <Sidebar current="Connections" />

      <main className="db-main">
        <Topbar
          title="Connections"
          text="Add and manage database connections."
        />

        <div className="conn-card">
          <h2 className="conn-card__title">Add Connection</h2>

          <div className="conn-form">
            <input
              type="text"
              placeholder="Database Name"
              className="conn-input"
            />

            <input
              type="text"
              placeholder="Host"
              className="conn-input"
            />

            <div className="conn-row">
              <input
                type="text"
                placeholder="Port"
                className="conn-input"
              />

              <select className="conn-select">
                <option>PostgreSQL</option>
                <option>MySQL</option>
                <option>SQL Server</option>
              </select>
            </div>

            <input
              type="text"
              placeholder="Username"
              className="conn-input"
            />

            <input
              type="password"
              placeholder="Password"
              className="conn-input"
            />

            <div className="conn-btn-group">
              <button className="conn-btn conn-btn--primary">
                Test Connection
              </button>
              <button className="conn-btn conn-btn--secondary">Save</button>
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
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Main Database</td>
                <td>PostgreSQL</td>
                <td>localhost:5432</td>
              </tr>
              <tr>
                <td>Testing Database</td>
                <td>MySQL</td>
                <td>localhost:3306</td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}