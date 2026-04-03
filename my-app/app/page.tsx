import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

export default function DashboardPage() {
  return (
    <div className="db-layout">
      <Sidebar current="Dashboard" />

      <main className="db-main">
        <Topbar
          title="Dashboard"
          text="Simple overview of the project."
        />

        <div className="db-card db-welcome-card">
          <h2 className="db-card__title">Welcome</h2>
          <p className="db-text">
            This system helps users manage database connections, compare schemas,
            detect versions, and review SQL scripts.
          </p>
        </div>

        <div className="db-stats-row">
          <div className="db-card db-stat-card">
            <p className="db-stat__label">Connections</p>
            <h2 className="db-stat__value">3</h2>
          </div>

          <div className="db-card db-stat-card">
            <p className="db-stat__label">Compared Schemas</p>
            <h2 className="db-stat__value">5</h2>
          </div>

          <div className="db-card db-stat-card">
            <p className="db-stat__label">Pending Scripts</p>
            <h2 className="db-stat__value">2</h2>
          </div>
        </div>

        <div className="db-card">
          <h2 className="db-card__title">Recent Activity</h2>
          <ul className="db-activity-list">
            <li>Added PostgreSQL connection</li>
            <li>Compared Schema A and Schema B</li>
            <li>Generated 1 SQL script</li>
          </ul>
        </div>
      </main>
    </div>
  );
}