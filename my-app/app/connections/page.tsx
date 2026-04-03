import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

export default function ConnectionsPage() {
  return (
    <div className="db-layout">
      <Sidebar current="Connections" />

      <main className="db-main">
        <Topbar
          title="Connections"
          text="Manage your database connections."
        />

        <div className="db-card">
          <div className="db-card__title">Database Connections</div>
          <p className="db-text">No connections added yet.</p>
        </div>
      </main>
    </div>
  );
}