import AuthGuard from "@/components/AuthGuard";

/**
 * The Visualizer reads saved connection credentials and introspects live
 * databases, so it stays behind auth — same pattern as Compare, Deploy,
 * Connections, and the Script Editor.
 */
export default function VisualizerLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
