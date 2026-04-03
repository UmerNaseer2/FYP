import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";

export default function VersionsPage() {
  return (
    <div className="db-layout">
      <Sidebar current="Version Detection" />

      <main className="db-main">
        <Topbar
          title="Version Detection"
          text="Check current schema version and update status."
        />

        <div className="version-grid">
          <div className="version-card">
            <h2 className="version-card__title">Version Table Status</h2>
            <p className="version-text">Version Table Found</p>
          </div>

          <div className="version-card">
            <h2 className="version-card__title">Version Info</h2>
            <p className="version-text">Current Version: v1.2.0</p>
            <p className="version-text">Latest Compared Version: v1.3.0</p>
            <p className="version-text">Status: Upgrade Needed</p>
          </div>
        </div>
      </main>
    </div>
  );
}