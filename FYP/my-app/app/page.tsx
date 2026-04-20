import Sidebar from "../components/Sidebar";

export default function Dashboard() {
  return (
    <div className="db-layout">
      <Sidebar current="Dashboard" />

      <main className="db-main">
        <header className="db-header-row">
          <div>
            <h1 className="text-4xl font-extrabold tracking-tighter text-slate-900">Project Overview</h1>
            <p className="text-slate-400 mt-1">Monitoring 3 active database connections.</p>
          </div>
          <div className="db-user-pill">
            <div className="db-user-avatar">AD</div>
            <span className="font-semibold text-sm">Admin User</span>
          </div>
        </header>

        {/* Hero Card */}
        <section className="dash-card dash-welcome-card">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
            <span className="text-xs font-bold uppercase tracking-widest text-green-400">System Optimal</span>
          </div>
          <p className="text-lg text-slate-300 leading-relaxed max-w-2xl">
            Your database schemas are currently in sync. No drifting detected in the last 24 hours across Production and Staging environments.
          </p>
        </section>

        {/* Stats */}
        <div className="dash-stats-grid">
          <div className="dash-card">
            <span className="stat-label">Connections</span>
            <span className="stat-value">03</span>
          </div>
          <div className="dash-card">
            <span className="stat-label">Schemas</span>
            <span className="stat-value">05</span>
          </div>
          <div className="dash-card">
            <span className="stat-label">Scripts</span>
            <span className="stat-value">02</span>
          </div>
        </div>

        {/* Activity List */}
        <div className="dash-card">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-6">Recent Activity</h3>
          <div className="activity-list">
            <div className="activity-item">
              <div className="activity-dot"></div>
              <div>
                <p className="font-bold text-slate-800">New PostgreSQL connection established</p>
                <p className="text-xs text-slate-400 mt-1">2 mins ago</p>
              </div>
            </div>
            <div className="activity-item">
              <div className="activity-dot"></div>
              <div>
                <p className="font-bold text-slate-800">Schema comparison: <mark>auth_db</mark> vs <mark>auth_db_backup</mark></p>
                <p className="text-xs text-slate-400 mt-1">1 hour ago</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}