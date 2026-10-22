"use client";

import { useState } from "react";
import { useDesktopBridge } from "@/hooks/useDesktopBridge";
import type { FoundDatabase } from "@/lib/desktop-bridge";
import { ChevronRightIcon, RefreshIcon, SearchIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// LocalDatabaseFinder: "Find databases on this computer", in the desktop app.
//
// The quickest start the add-connection drawer has when Schema Studio runs as
// the desktop app. It asks the app to look for PostgreSQL servers on this
// computer (on the usual ports, and in Docker), lists what answered, and hands
// the one picked back to the drawer, which fills in everything except the
// password. The person types that: the app never reads a password, not even
// from a Docker container's settings, so it never holds a secret it was not
// given.
//
// A web page cannot look around the computer it runs on, so in a browser this
// renders nothing and the drawer is exactly as it was.
// ---------------------------------------------------------------------------

type Search =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; found: FoundDatabase[] }
  | { kind: "failed" };

/**
 * The second line of a found database: where it is, and the user and database
 * when the app could learn them. A server only seen answering on a port says
 * so, rather than showing the defaults the drawer is about to fill in as if
 * they had been read from it.
 */
function whereLine(db: FoundDatabase): string {
  const known: string[] = [];
  if (db.user) known.push(`user ${db.user}`);
  if (db.database) known.push(`database ${db.database}`);
  const details = known.length > 0 ? known.join(" · ") : "user and database not known";
  return `${db.host}:${db.port} · ${details}`;
}

/** The sentence under the heading, which is also what a screen reader hears. */
function statusText(search: Search): string {
  switch (search.kind) {
    case "idle":
      return "Looks for PostgreSQL on this computer, on the usual ports and in Docker, and fills in everything below except the password.";
    case "searching":
      return "Looking on the usual ports and in Docker…";
    case "failed":
      return "Schema Studio could not look for databases just now. Look again, or fill in the details below.";
    case "done":
      if (search.found.length === 0) {
        return "Nothing found. No PostgreSQL server answered on the usual ports, and Docker has none running. Start one and look again, or fill in the details below.";
      }
      return search.found.length === 1
        ? "Found 1 database. Pick it to fill in the details below."
        : `Found ${search.found.length} databases. Pick one to fill in the details below.`;
  }
}

export function LocalDatabaseFinder({ onPick }: { onPick: (found: FoundDatabase) => void }) {
  const desktop = useDesktopBridge();
  const [search, setSearch] = useState<Search>({ kind: "idle" });

  if (!desktop) return null;

  const look = async () => {
    setSearch({ kind: "searching" });
    try {
      setSearch({ kind: "done", found: await desktop.findLocalDatabases() });
    } catch {
      // The app's own reason is not shown: an error that crossed from the app
      // arrives wrapped in Electron's wording, which helps nobody here. The
      // details are in the app's log (Help > Open Logs).
      setSearch({ kind: "failed" });
    }
  };

  const searching = search.kind === "searching";
  const found = search.kind === "done" ? search.found : [];

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="label">On this computer</div>
        <button
          type="button"
          className="btn btn-secondary btn-xs"
          onClick={look}
          disabled={searching}
          aria-busy={searching || undefined}
        >
          {searching ? <RefreshIcon size={11} className="spin-icon" /> : <SearchIcon size={11} />}
          {searching ? "Looking…" : search.kind === "idle" ? "Find databases" : "Look again"}
        </button>
      </div>
      <p className="help" role="status">
        {statusText(search)}
      </p>
      {found.length > 0 && (
        <ul className="local-finder" aria-label="Databases found on this computer">
          {found.map((db) => (
            <li key={`${db.source}:${db.host}:${db.port}`}>
              <button type="button" className="local-finder__pick" onClick={() => onPick(db)}>
                <span className="local-finder__text">
                  <span className="local-finder__name">{db.label}</span>
                  <span className="local-finder__where mono">{whereLine(db)}</span>
                </span>
                {db.source === "docker" && (
                  <span className="pill pill-outline" title={db.container ? `Docker container ${db.container}` : undefined}>
                    Docker
                  </span>
                )}
                <ChevronRightIcon size={14} className="local-finder__chev" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
