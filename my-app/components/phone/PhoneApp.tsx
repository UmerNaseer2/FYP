"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";
import { BellIcon, ClipboardIcon, CompareIcon, DriftIcon, InboxIcon } from "@/components/ui/icons";
import { useOrg } from "@/hooks/useOrg";
import { useRequestCounts } from "@/hooks/useRequestCounts";
import { useUser } from "@/hooks/useUser";
import { loginHref } from "@/lib/callback-url";
import { keepDeviceOnFile, turnAlertsOff } from "@/lib/phone-push-client";
import { signOutEverywhere } from "@/lib/sign-out";
import "@/app/styles/atelier-devices.css";
import AlertsTab from "./AlertsTab";
import ApprovalsTab from "./ApprovalsTab";
import CompareTab from "./CompareTab";
import DriftTab from "./DriftTab";
import HistoryTab from "./HistoryTab";

type TabKey = "drift" | "history" | "approvals" | "compare" | "alerts";

type Tab = { key: TabKey; label: string; icon: ReactNode };

const TABS: Tab[] = [
  { key: "drift", label: "Drift", icon: <DriftIcon className="ico" /> },
  { key: "history", label: "History", icon: <ClipboardIcon className="ico" /> },
  { key: "approvals", label: "Approvals", icon: <InboxIcon className="ico" /> },
  { key: "compare", label: "Compare", icon: <CompareIcon className="ico" /> },
  { key: "alerts", label: "Alerts", icon: <BellIcon className="ico" /> },
];

export default function PhoneApp() {
  const org = useOrg();
  const { can } = useUser();
  const pathname = usePathname();
  const params = useSearchParams();
  const waiting = useRequestCounts(true, pathname);

  const canReadDrift = can("drift:read");
  const canCompare = can("compare:read");
  const tabs = TABS.filter((entry) => {
    if (entry.key === "compare") return canCompare;
    return canReadDrift || (entry.key !== "drift" && entry.key !== "history");
  });
  // Read once. An alert's link opens a whole new page, so it starts here again.
  const [tab, setTab] = useState<TabKey>(
    () => tabs.find((entry) => entry.key === params.get("tab"))?.key ?? tabs[0].key
  );
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    // Nothing to tell the person if this fails. It runs again next time.
    keepDeviceOnFile().catch(() => undefined);
  }, []);

  async function signOut() {
    setSigningOut(true);
    // Otherwise this device would go on showing alerts to whoever holds it next.
    await turnAlertsOff().catch(() => undefined);
    await signOutEverywhere(loginHref("/phone"));
  }

  return (
    <div className="dv-app">
      <header className="dv-app__bar">
        <h1>{org?.name ?? "Schema Studio"}</h1>
        <Button size="sm" variant="ghost" disabled={signingOut} onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>

      <main className="dv-app__main">
        <h2 className="dv-app__title">{tabs.find((entry) => entry.key === tab)?.label}</h2>
        {tab === "drift" && <DriftTab />}
        {tab === "history" && <HistoryTab />}
        {tab === "approvals" && <ApprovalsTab />}
        {tab === "compare" && <CompareTab />}
        {tab === "alerts" && <AlertsTab />}
      </main>

      <nav aria-label="Phone app" className="dv-app__tabs">
        {tabs.map((entry) => {
          const active = entry.key === tab;
          return (
            <button
              key={entry.key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setTab(entry.key)}
              className="dv-app__tab"
            >
              {entry.icon}
              <span>{entry.label}</span>
              {entry.key === "approvals" && waiting > 0 && (
                <span aria-label={`${waiting} waiting`} className="dv-app__count">
                  {waiting}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
