import AuthGuard from "@/components/AuthGuard";

/**
 * Version Sync reads two saved connections' live ledgers and (in P4) replays
 * migrations onto a live database, so it stays behind auth — same pattern as
 * Deploy, Compare, and the Script Editor.
 */
export default function VersionSyncLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
