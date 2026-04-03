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

        <div className="db-card">
          <h2 className="db-card__title">Add Connection</h2>

          <div className="db-form">
            <input
              type="text"
              placeholder="Database Name"
              className="db-form__input"
            />

            <input
              type="text"
              placeholder="Host"
              className="db-form__input"
            />

            <div className="db-form__row">
              <input
                type="text"
                placeholder="Port"
                className="db-form__input"
              />

              <select className="db-form__select">
                <option>PostgreSQL</option>
                <option>MySQL</option>
                <option>SQL Server</option>
              </select>
            </div>

            <input
              type="text"
              placeholder="Username"
              className="db-form__input"
            />

            <input
              type="password"
              placeholder="Password"
              className="db-form__input"
            />

            <div className="db-btn-group">
              <button className="db-btn db-btn--primary">
                Test Connection
              </button>
              <button className="db-btn db-btn--secondary">
                Save
              </button>
            </div>
          </div>
        </div>

        <div className="db-card">
          <h2 className="db-card__title">Saved Connections</h2>

          <table className="db-table">
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