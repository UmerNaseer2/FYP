import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";

export default function VersionsPage() {
  return (
    <div className="db-layout">
      <Sidebar current="Version Detection" />

      <main className="db-main">
        <Topbar
          title="Version Detection"
          text="Check current schema version and update status."
        />

        <div className="db-grid db-grid--2">
          <div className="db-card">
            <div className="db-card__title">Version Table Status</div>
            <p>Version Table Found</p>
          </div>

          <div className="db-card">
            <div className="db-card__title">Version Info</div>
            <p>Current Version: v1.2.0</p>
            <p>Latest Compared Version: v1.3.0</p>
            <p>Status: Upgrade Needed</p>
          </div>
        </div>
      </main>
    </div>
  );
}