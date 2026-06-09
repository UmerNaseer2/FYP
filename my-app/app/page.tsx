import { redirect } from "next/navigation";

// The dashboard now lives inside the studio shell at /studio. The legacy stats
// dashboard that used to render here was retired in the Phase 10 cleanup, so the
// root path simply forwards to the real dashboard.
export default function RootPage() {
  redirect("/studio");
}
