import { redirect } from "next/navigation";
import { signIn } from "next-auth/react";

// The dashboard now lives inside the studio shell at /studio. The legacy stats
// dashboard that used to render here was retired in the Phase 10 cleanup, so the
// root path normally just forwards to the real dashboard.
//
// EXCEPTION: Azure SSO (PKCE) returns the browser here with a `?code=…`. We must
// NOT redirect in that case — a server-side redirect drops the query string and
// loses the code before it can be exchanged for a session. Instead we render a
// small client component that completes the exchange and then forwards in.
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  if (params.code) {
  
await signIn("microsoft-entra-id", { callbackUrl: "/studio" });
  }
  redirect("/studio");
}
