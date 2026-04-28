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

        <div className="dash-card dash-welcome-card">
          <h2 className="dash-card__title">Welcome</h2>
          <p className="dash-text">
            This system helps users manage database connections, compare schemas,
            detect versions, and review SQL scripts.
          </p>
        </div>

        <div className="dash-stats-row">
          <div className="dash-card dash-stat-card">
            <p className="dash-stat__label">Connections</p>
            <h2 className="dash-stat__value">3</h2>
          </div>

          <div className="dash-card dash-stat-card">
            <p className="dash-stat__label">Compared Schemas</p>
            <h2 className="dash-stat__value">5</h2>
          </div>

          <div className="dash-card dash-stat-card">
            <p className="dash-stat__label">Pending Scripts</p>
            <h2 className="dash-stat__value">2</h2>
          </div>
        </div>

        <div className="dash-card">
          <h2 className="dash-card__title">Recent Activity</h2>
          <ul className="dash-activity-list">
            <li className="dash-activity-item">Added PostgreSQL connection</li>
            <li className="dash-activity-item">Compared Schema A and Schema B</li>
            <li className="dash-activity-item">Generated 1 SQL script</li>
          </ul>
        </div>
      </main>
    </div>
  );
}