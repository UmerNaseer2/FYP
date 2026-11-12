"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/studio/PageHeader";
import { Skeleton } from "@/components/ui";
import {
  AlertCircleIcon,
  BellIcon,
  CheckIcon,
  ChevronRightIcon,
  CompareIcon,
  DriftIcon,
  InboxIcon,
  LockIcon,
  MonitorIcon,
  RefreshIcon,
  VersionSyncIcon,
} from "@/components/ui/icons";
import { useDesktopBridge } from "@/hooks/useDesktopBridge";
import { useOrg, useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import { apiFetch } from "@/lib/api-fetch";
import type { DesktopSyncStatus } from "@/lib/desktop-bridge";
import { devicesHelp } from "@/lib/help/devices";
import { timeAgo } from "@/lib/time-ago";
import "@/app/styles/atelier-devices.css";

/**
 * Phone and desktop: the three ways into Schema Studio, and how they share
 * one organization.
 *
 * Most of this page is explanation, with links to the real pages (the phone
 * app and Link a computer). The only live data is the list of linked
 * computers (GET /api/connections/computers) and, inside the desktop app,
 * whether this computer is linked. Nothing here is an example or a mock-up.
 */

type Tab = "phone" | "desktop" | "sync";

const TABS: { id: Tab; label: string }[] = [
  { id: "phone", label: "Phone app" },
  { id: "desktop", label: "Desktop app" },
  { id: "sync", label: "Sync" },
];

/** One linked computer, as GET /api/connections/computers lists it. */
type Computer = {
  id: number;
  name: string;
  /** Who linked it. */
  owner: string;
  mine: boolean;
  online: boolean;
  lastSeenAt: string | null;
  connections: { id: number; name: string; environment: string | null }[];
};

/** Where the read of the linked computers stands. */
type ComputersState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; computers: Computer[] };

export default function DevicesPage() {
  const [tab, setTab] = useState<Tab>("phone");

  return (
    <div className="dv-page">
      <PageHeader page="/devices" title={devicesHelp.title} blurb={devicesHelp.blurb} />

      <div className="dv-tabs" role="group" aria-label="Ways in">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="dv-tab"
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "phone" && <PhoneTab />}
      {tab === "desktop" && <DesktopTab />}
      {tab === "sync" && <SyncTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Phone app                                                           */
/* ------------------------------------------------------------------ */

/** The phone app's five screens, in the order of its bottom bar. */
const PHONE_SCREENS = [
  { name: "Drift", what: "See your schemas and whether any has drifted.", icon: <DriftIcon size={18} /> },
  { name: "History", what: "Read what was deployed, and when.", icon: <VersionSyncIcon size={18} /> },
  { name: "Approvals", what: "Say yes or no to a request.", icon: <InboxIcon size={18} /> },
  { name: "Compare", what: "Run a compare on your computer and read the result.", icon: <CompareIcon size={18} /> },
  { name: "Alerts", what: "Choose which drift alerts reach this phone.", icon: <BellIcon size={18} /> },
];

function PhoneTab() {
  const orgPath = useOrgHref();

  return (
    <section className="dv-g" aria-label="Phone app">
      <PhonePicture />

      <div className="dv-side">
        <div className="dv-card">
          <h2>What the phone is for</h2>
          <ul className="dv-list">
            {PHONE_SCREENS.map((screen) => (
              <li key={screen.name}>
                <span className="dv-list__ico" aria-hidden="true">
                  {screen.icon}
                </span>
                <span>
                  <b>{screen.name}.</b> {screen.what}
                </span>
              </li>
            ))}
          </ul>
          <p className="dv-safe">
            <LockIcon size={16} />
            <span>
              It never holds a database password. A compare runs on one of your own linked
              computers, so that computer has to be on.
            </span>
          </p>
        </div>

        <div className="dv-card">
          <h2>Open it on your phone</h2>
          <ol className="dv-steps">
            <li>Open this site in your phone&apos;s web browser and sign in with the same account.</li>
            <li>Open the phone app from the link below. It is the same address on every device.</li>
            <li>Keep the page in your browser, or add it to your home screen if your phone offers that.</li>
          </ol>
          <div className="dv-acts">
            <Link href={orgPath("/phone")} className="btn btn-primary">
              Open the phone app
              <ChevronRightIcon size={16} />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A drawing of a phone showing the app's five tabs. It carries no data: the
 * tab names are the real ones, and the rest is plain shapes. Hidden from
 * screen readers, because the list beside it says the same in words.
 */
function PhonePicture() {
  return (
    <div className="dv-phone" aria-hidden="true">
      <div className="dv-phone__screen">
        <div className="dv-phone__bar" />
        <div className="dv-phone__line dv-phone__line--title" />
        <div className="dv-phone__block" />
        <div className="dv-phone__block" />
        <div className="dv-phone__block dv-phone__block--short" />
        <div className="dv-phone__nav">
          {PHONE_SCREENS.map((screen) => (
            <span key={screen.name}>
              {screen.icon}
              {screen.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Desktop app                                                         */
/* ------------------------------------------------------------------ */

function DesktopTab() {
  const bridge = useDesktopBridge();

  return (
    <section className="dv-stack" aria-label="Desktop app">
      <p className="dv-lead">
        The desktop app is the same Schema Studio with its own database on the computer. It runs
        on Ubuntu, and it can reach databases that only that computer can reach.
      </p>
      {bridge ? <ThisComputer /> : <LinkedComputers />}
    </section>
  );
}

/** Inside the desktop app: whether this computer is linked to a website. */
function ThisComputer() {
  const bridge = useDesktopBridge();
  const [status, setStatus] = useState<DesktopSyncStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge
      .syncStatus()
      .then((answer) => {
        if (live) setStatus(answer);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [bridge]);

  return (
    <div className="dv-card">
      <h2>This computer</h2>
      {failed ? (
        <p className="dv-error" role="alert">
          <AlertCircleIcon size={16} />
          <span>Could not read whether this computer is linked. Open Settings to check.</span>
        </p>
      ) : status === null ? (
        <div role="status" aria-label="Loading">
          <Skeleton height={20} width="60%" />
        </div>
      ) : status.linked ? (
        <>
          <p className="dv-row">
            <span className="dv-row__ico" aria-hidden="true">
              <MonitorIcon size={18} />
            </span>
            <span className="dv-row__text">
              <b>Linked to {status.orgName}</b>
              <span>
                {status.online
                  ? "The website can be reached."
                  : "The website cannot be reached right now, so its connections are locked here."}
                {status.lastSyncedAt !== null &&
                  ` Last synced ${timeAgo(new Date(status.lastSyncedAt).toISOString())}.`}
              </span>
            </span>
            <span className={status.online ? "pill pill-sync" : "pill pill-neutral"}>
              {status.online ? "Online" : "Offline"}
            </span>
          </p>
        </>
      ) : (
        <p className="dv-text">
          This computer is not linked to a website. Everything you save stays here. To share an
          organization&apos;s connections, open Settings, enter the site&apos;s address and press
          Link.
        </p>
      )}
      <div className="dv-acts">
        <button type="button" className="btn btn-secondary" onClick={() => bridge?.openSettings()}>
          Open Settings
        </button>
      </div>
    </div>
  );
}

/** On the website: the computers linked to this organization, and how to link one. */
function LinkedComputers() {
  const orgPath = useOrgHref();
  const org = useOrg();
  const { loading: sessionLoading, can } = useUser();
  const mayList = !sessionLoading && can("connections:read");
  const [state, setState] = useState<ComputersState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await apiFetch("/api/connections/computers");
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !Array.isArray(data.computers)) {
        const message =
          data && typeof data.error === "string" ? data.error : "Could not list the linked computers.";
        setState({ kind: "error", message });
        return;
      }
      setState({ kind: "ready", computers: data.computers });
    } catch {
      setState({ kind: "error", message: "Could not reach the site. Check your connection and try again." });
    }
  }, []);

  useEffect(() => {
    if (!mayList) return;
    // Reading the list is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [mayList, load]);

  return (
    <>
      <div className="dv-card">
        <div className="dv-card__head">
          <h2>Linked computers</h2>
          {mayList && state.kind === "ready" && (
            <button type="button" className="btn btn-ghost btn-sm dv-tap" onClick={() => void load()}>
              <RefreshIcon size={14} />
              Refresh
            </button>
          )}
        </div>

        {sessionLoading ? (
          <ComputersLoading />
        ) : !mayList ? (
          <p className="role-note dv-note" role="note">
            <LockIcon size={16} />
            <span>
              Your role cannot see the linked computers. That needs a role that may read
              connections. Ask an Admin if you need it.
            </span>
          </p>
        ) : state.kind === "loading" ? (
          <ComputersLoading />
        ) : state.kind === "error" ? (
          <div className="dv-error" role="alert">
            <AlertCircleIcon size={16} />
            <span>{state.message}</span>
            <button type="button" className="btn btn-secondary btn-sm dv-tap" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : state.computers.length === 0 ? (
          <p className="dv-text">
            No computer is linked{org ? ` to ${org.name}` : ""} yet. Follow the steps below to link
            one.
          </p>
        ) : (
          <ul className="dv-computers" aria-label="Linked computers">
            {state.computers.map((computer) => (
              <li key={computer.id} className="dv-row">
                <span className="dv-row__ico" aria-hidden="true">
                  <MonitorIcon size={18} />
                </span>
                <span className="dv-row__text">
                  <b>{computer.name}</b>
                  <span>
                    {computer.mine ? "Yours" : computer.owner}
                    {" · "}
                    {connectionCount(computer.connections.length)}
                    {!computer.online && computer.lastSeenAt && ` · last seen ${timeAgo(computer.lastSeenAt)}`}
                  </span>
                </span>
                <span className={computer.online ? "pill pill-sync" : "pill pill-neutral"}>
                  {computer.online ? "Online" : "Offline"}
                </span>
              </li>
            ))}
          </ul>
        )}

        {mayList && state.kind === "ready" && state.computers.length > 0 && (
          <p className="dv-foot">
            To unlink a computer, open{" "}
            <Link href={orgPath("/connections")} className="dv-a">
              Connections
            </Link>{" "}
            and look under On linked computers.
          </p>
        )}
      </div>

      <div className="dv-card">
        <h2>Link a computer</h2>
        <ol className="dv-steps">
          <li>On the computer, open Schema Studio&apos;s Settings, enter this site&apos;s address and press Link.</li>
          <li>The app shows a code of eight letters and numbers. It works for 10 minutes.</li>
          <li>Type the code on the Link a computer page and check the computer&apos;s name.</li>
        </ol>
        <p className="warn-inline dv-note">
          <AlertCircleIcon size={16} />
          <span>
            Only link a computer you are sitting at. A linked computer gets this organization&apos;s
            saved connections, with their passwords.
          </span>
        </p>
        <div className="dv-acts">
          <Link href={orgPath("/link-computer")} className="btn btn-primary">
            Link a computer
            <ChevronRightIcon size={16} />
          </Link>
        </div>
      </div>
    </>
  );
}

function ComputersLoading() {
  return (
    <div className="dv-loading" role="status" aria-label="Loading linked computers">
      <Skeleton height={44} radius={12} />
      <Skeleton height={44} radius={12} />
    </div>
  );
}

function connectionCount(n: number): string {
  if (n === 0) return "keeps no connections of its own";
  return n === 1 ? "1 connection of its own" : `${n} connections of its own`;
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

/** The rules for which copy wins. The same three as the help file. */
const SYNC_RULES = [
  {
    title: "The website is the master",
    text: "Members, roles, versions and cloud connections come from it.",
  },
  {
    title: "Cloud connections lock offline",
    text: "While a computer cannot reach the website, it can use them but not change them.",
  },
  {
    title: "Local passwords stay home",
    text: "A connection saved only in the desktop app is listed for the organization by name only.",
  },
];

function SyncTab() {
  return (
    <section className="dv-stack" aria-label="Sync">
      <div className="dv-card">
        <h2>How the copies stay the same</h2>
        <div className="dv-flow">
          <div className="dv-flow__end">
            <span className="dv-row__ico" aria-hidden="true">
              <VersionSyncIcon size={18} />
            </span>
            <b>Website</b>
            <span>Holds the organization</span>
          </div>
          <div className="dv-flow__wire" aria-hidden="true">
            <span />
          </div>
          <div className="dv-flow__end">
            <span className="dv-row__ico" aria-hidden="true">
              <MonitorIcon size={18} />
            </span>
            <b>Desktop app</b>
            <span>A linked computer</span>
          </div>
        </div>
        <p className="dv-text">
          A linked computer checks with the website while it is on. The phone app needs no
          syncing, because it reads straight from the website.
        </p>
      </div>

      <div className="dv-card">
        <h2>Who wins</h2>
        <ol className="dv-rules">
          {SYNC_RULES.map((rule) => (
            <li key={rule.title}>
              <span className="dv-rules__mark" aria-hidden="true">
                <CheckIcon size={14} />
              </span>
              <span>
                <b>{rule.title}.</b> {rule.text}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
