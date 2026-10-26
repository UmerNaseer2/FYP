import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { StudioShell } from "@/components/studio/StudioShell";
import { ViewAsCookie } from "@/components/ViewAsCookie";
import { BYPASS_AUTH, VIEW_AS_COOKIE } from "@/lib/auth-mode";

// Every route in the (studio) group renders inside the new design-system shell.
// This is additive: legacy pages outside this group keep their own layout.
//
// With the bypass on, the layout also tells the page whether a View as cookie
// came with the request, so the first frame already shows the role it names
// (see components/ViewAsCookie.tsx). Reading a cookie makes these pages render
// on each request instead of once at build time, which is what they need while
// the answer depends on the cookie.
export default async function StudioLayout({ children }: { children: ReactNode }) {
  if (!BYPASS_AUTH) return <StudioShell>{children}</StudioShell>;

  const seen = Boolean((await cookies()).get(VIEW_AS_COOKIE)?.value);
  return (
    <ViewAsCookie seen={seen}>
      <StudioShell>{children}</StudioShell>
    </ViewAsCookie>
  );
}
