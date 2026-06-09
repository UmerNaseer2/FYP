import AuthGuard from "@/components/AuthGuard";

/**
 * The Script Editor reads saved connections, queries their script_patch tables,
 * and writes .sql files to the GitHub registry, so it stays behind auth — same
 * pattern as Deploy, Connections, and Compare.
 */
export default function ScriptEditorLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
