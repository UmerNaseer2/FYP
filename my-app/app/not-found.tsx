import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { CompareIcon, DashboardIcon, SearchIcon } from "@/components/ui/icons";

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
// keeps the sidebar. See app/(studio)/schemas/[id]/page.tsx.
// ---------------------------------------------------------------------------

export default function NotFound() {
  return (
    <div style={{ height: "100vh", background: "var(--bg)" }}>
      <EmptyState
        icon={<SearchIcon size={22} />}
        title="There is no page here"
        description="The address you opened doesn't match any screen in Schema Studio. It may have been a link from an older version."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/studio" className="btn btn-primary btn-sm">
              <DashboardIcon size={14} /> Dashboard
            </Link>
            <Link href="/compare" className="btn btn-secondary btn-sm">
              <CompareIcon size={14} /> Compare &amp; Author
            </Link>
          </div>
        }
      />
    </div>
  );
}
