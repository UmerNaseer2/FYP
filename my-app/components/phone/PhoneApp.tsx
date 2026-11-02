"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";
import { BellIcon, ClipboardIcon, DriftIcon, InboxIcon } from "@/components/ui/icons";
import { useOrg } from "@/hooks/useOrg";
import { useRequestCounts } from "@/hooks/useRequestCounts";
import { useUser } from "@/hooks/useUser";
import { loginHref } from "@/lib/callback-url";
import { keepDeviceOnFile, turnAlertsOff } from "@/lib/phone-push-client";
import { signOutEverywhere } from "@/lib/sign-out";
import AlertsTab from "./AlertsTab";
import ApprovalsTab from "./ApprovalsTab";
import DriftTab from "./DriftTab";
import HistoryTab from "./HistoryTab";

type TabKey = "drift" | "history" | "approvals" | "alerts";

type Tab = { key: TabKey; label: string; icon: ReactNode };

const TABS: Tab[] = [
  { key: "drift", label: "Drift", icon: <DriftIcon className="ico" /> },
  { key: "history", label: "History", icon: <ClipboardIcon className="ico" /> },
  { key: "approvals", label: "Approvals", icon: <InboxIcon className="ico" /> },
  { key: "alerts", label: "Alerts", icon: <BellIcon className="ico" /> },
];

export default function PhoneApp() {
  const org = useOrg();
  const { can } = useUser();
  const pathname = usePathname();
  const params = useSearchParams();
  const waiting = useRequestCounts(true, pathname);

  const canReadDrift = can("drift:read");
  const tabs = TABS.filter(
    (entry) => canReadDrift || (entry.key !== "drift" && entry.key !== "history")
  );
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
    <div className="min-h-[100dvh]" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <header
        className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          paddingTop: "max(12px, env(safe-area-inset-top))",
        }}
      >
        <h1 className="text-[15px] font-semibold truncate">{org?.name ?? "Schema Studio"}</h1>
        <Button size="sm" variant="ghost" disabled={signingOut} onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>

      <main className="mx-auto max-w-[560px] px-4 pt-4 pb-24">
        {tab === "drift" && <DriftTab />}
        {tab === "history" && <HistoryTab />}
        {tab === "approvals" && <ApprovalsTab />}
        {tab === "alerts" && <AlertsTab />}
      </main>

      <nav
        aria-label="Phone app"
        className="fixed bottom-0 inset-x-0 z-10 flex"
        style={{
          background: "var(--surface)",
          borderTop: "1px solid var(--border)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {tabs.map((entry) => {
          const active = entry.key === tab;
          return (
            <button
              key={entry.key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setTab(entry.key)}
              className="relative flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium"
              style={{ color: active ? "var(--brand)" : "var(--text-3)", minHeight: 52 }}
            >
              {entry.icon}
              <span>{entry.label}</span>
              {entry.key === "approvals" && waiting > 0 && (
                <span
                  aria-label={`${waiting} waiting`}
                  className="absolute top-1 left-1/2 ml-2 px-1 rounded-full text-[10px] leading-[14px]"
                  style={{ background: "var(--break)", color: "var(--text-inv)" }}
                >
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
