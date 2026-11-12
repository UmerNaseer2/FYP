import Link from "next/link";
import { LandingThemeToggle } from "@/components/landing/LandingThemeToggle";
import { BrandMark } from "@/components/ui/BrandMark";
import { CompareIcon, DashboardIcon } from "@/components/ui/icons";
import "@/app/styles/atelier-onboarding.css";

// ---------------------------------------------------------------------------
// 404. Shown for any URL that matches no route at all — a stale bookmark, a
// mistyped path, a link in a change log that outlived the screen it pointed at.
//
// Next's built-in version is the words "404" and "This page could not be
// found", with nothing to click. That is a dead end in an application whose
// screens are only reachable from the sidebar, so this one names the two places
// somebody is most likely to have been heading.
//
// A tracked schema that has been deleted does NOT come through here: the
// dashboard's detail screen loads it over the API and says so in place, which
// keeps the sidebar. See app/[org]/(studio)/schemas/[id]/page.tsx.
//
// An organization's address that the person opening it does not belong to
// DOES come through here (app/[org]/layout.tsx), and looks exactly like an
// address nobody has. Saying "you are not a member" would tell a stranger
// which organizations exist. The two buttons go to addresses with no
// organization in them, which take a signed-in person on to the last
// organization they opened (lib/org-redirect.ts).
// ---------------------------------------------------------------------------

export default function NotFound() {
  return (
    <div className="ob-page">
      <header className="ob-nav">
        <div className="brand">
          <BrandMark size={30} />
          <span className="brand-name">Schema Studio</span>
        </div>
        {/* Also puts the saved theme back: on this page React redraws the whole
            document in the browser, which drops the head script's choice. */}
        <div className="ob-tools">
          <LandingThemeToggle />
        </div>
      </header>
      <main className="ob-main">
        <article className="card ob-card">
          <div className="ob-head">
            <span className="ob-code mono" aria-hidden="true">404</span>
            <h1>There is no page here</h1>
            <p>
              The address you opened doesn&apos;t match any screen in Schema Studio. It may be a link
              from an older version, or to an organization you are not a member of.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/studio" className="btn btn-primary">
              <DashboardIcon size={14} /> Dashboard
            </Link>
            <Link href="/compare" className="btn btn-secondary">
              <CompareIcon size={14} /> Compare &amp; Author
            </Link>
          </div>
        </article>
      </main>
    </div>
  );
}
