"use client";

import AuthGuard from "@/components/AuthGuard";
import { useEffect, useState } from "react";
import Link from "next/link";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

type DashboardData = {
  totalConnections: number;
  activeConnections: number;
  comparedSchemas: number;
  pendingScripts: number;
  systemStatus: string;
  updatedAt: string;
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData>({
    totalConnections: 0,
    activeConnections: 0,
    comparedSchemas: 0,
    pendingScripts: 0,
    systemStatus: "Loading",
    updatedAt: "",
  });

  async function fetchDashboard() {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      const json = await res.json();
      setData(json);
    } catch {
      setData((prev) => ({
        ...prev,
        systemStatus: "API Error",
        updatedAt: new Date().toLocaleString(),
      }));
    }
  }

  useEffect(() => {
    fetchDashboard();
    const timer = setInterval(fetchDashboard, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
<AuthGuard>
      <div className="db-layout">
      <Sidebar current="Dashboard" />

      <main className="db-main">
        <Topbar
          title="Dashboard"
          text="Real-time overview of your database schema management system."
        />

        <section className="dash-card">
          <h2 className="dash-card__title">System Overview</h2>

          <div className="dash-overview-row">
            <div>
              <p className="dash-text">Status</p>
              <h3 className="dash-status">{data.systemStatus}</h3>
            </div>

            <div>
              <p className="dash-text">Last Updated</p>
              <h3 className="dash-status">{data.updatedAt || "-"}</h3>
            </div>
          </div>
        </section>

        <section className="dash-stats-row">
          <div className="dash-card dash-stat-card">
            <p className="dash-stat__label">Total Connections</p>
            <h2 className="dash-stat__value">{data.totalConnections}</h2>
          </div>

          <div className="dash-card dash-stat-card">
            <p className="dash-stat__label">Active Connections</p>
            <h2 className="dash-stat__value">{data.activeConnections}</h2>
          </div>

          <div className="dash-card dash-stat-card">
            <p className="dash-stat__label">Compared Schemas</p>
            <h2 className="dash-stat__value">{data.comparedSchemas}</h2>
          </div>

          <div className="dash-card dash-stat-card">
            <p className="dash-stat__label">Pending Scripts</p>
            <h2 className="dash-stat__value">{data.pendingScripts}</h2>
          </div>
        </section>

        <section className="dash-card">
          <h2 className="dash-card__title">Quick Actions</h2>

          <div className="dash-action-grid">
            <Link href="/connections" className="dash-action-box">
              Manage Connections
            </Link>

            <Link href="/versions" className="dash-action-box">
              Version Detection
            </Link>

            <Link href="/compare" className="dash-action-box">
              Compare Schemas
            </Link>

            <Link href="/scripts" className="dash-action-box">
              SQL Scripts
            </Link>
          </div>
        </section>
      </main>
    </div>
    </AuthGuard>
  );
}