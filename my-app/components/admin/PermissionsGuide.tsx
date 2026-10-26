"use client";

import { Fragment, useEffect, useRef } from "react";
import { ACTIONS, ACTION_LABELS, type Action } from "@/lib/permissions";
import { ChevronDownIcon, InfoIcon } from "@/components/ui/icons";

/**
 * The short guide at the top of the Admin page: how to set up a role, what
 * each box in the grid means, and the few rules worth knowing before ticking
 * anything. Section 11 of the user manual says the same at more length, so a
 * change to how roles work wants a change to both.
 *
 * It is a folding panel. It opens on the first visit, so a new admin finds it
 * without looking for it, and once they fold it away it stays folded in that
 * browser until they open it again.
 */

// What this browser remembers, under the same "ss-" prefix as the theme
// (hooks/useTheme.ts). Only ever "closed", or nothing at all.
const GUIDE_KEY = "ss-admin-guide";

// One line for each column of the grid. A Record over every action, so adding
// an action to lib/permissions.ts fails the type check until it is explained
// here too. The examples are real boxes from that file, and only ones another
// role can be given, never the admin-only rows.
const WHAT_EACH_BOX_MEANS: Record<Action, string> = {
  create: "Add something new, such as a connection, a saved comparison set or a tracked schema.",
  read: "Open the screen and see what is on it. Every other box needs this one.",
  update: "Change something that is already there, such as a saved connection or an alert threshold.",
  delete: "Remove something, such as a connection or a tracked schema.",
  run: "Do real work on a database: apply or revert a migration, run a drift check, or measure a query.",
  // Two exceptions let someone clear their own request: sign-in switched off
  // for testing, where there is only one person, and an organization whose
  // two-person rule is off (lib/approvals-db.ts, mayDecideOwn).
  approve:
    "Approve a production run. Nobody can approve a request they made themselves, unless the " +
    "organization has switched its two-person rule off on the Organization tab.",
};

type PermissionsGuideProps = {
  /**
   * Whether to explain View as. It is only on the sidebar while sign-in is
   * switched off for testing, so with real sign-in there is nothing to point at.
   */
  showViewAs: boolean;
};

export function PermissionsGuide({ showViewAs }: PermissionsGuideProps) {
  const panel = useRef<HTMLDetailsElement>(null);

  // Drawn folded, which is also how the server draws it, so the first frame
  // matches and nothing jumps for someone who folded it away before. Then it
  // opens, unless this browser remembers it being folded.
  //
  // It sets `open` on the element rather than keeping it in state, because the
  // browser folds and unfolds a <details> by itself when its header is clicked.
  // Two copies of "is it open" (React's and the browser's) could disagree;
  // one cannot.
  useEffect(() => {
    let folded = false;
    try {
      folded = localStorage.getItem(GUIDE_KEY) === "closed";
    } catch {
      // Storage is blocked (some private windows). The guide opens every time.
    }
    if (!folded && panel.current) panel.current.open = true;
  }, []);

  // Runs on every fold and unfold, the person's and the one above. The one
  // above only ever writes down "open", which is what it is, so it is harmless.
  function remember(open: boolean) {
    try {
      if (open) localStorage.removeItem(GUIDE_KEY);
      else localStorage.setItem(GUIDE_KEY, "closed");
    } catch {
      // Nothing is remembered, so the guide opens again on the next visit.
    }
  }

  return (
    <details
      ref={panel}
      className="table-group admin-guide mt-6"
      onToggle={(event) => remember(event.currentTarget.open)}
    >
      <summary className="tg-header">
        <InfoIcon size={15} className="admin-guide__ico" />
        <span className="admin-guide__title">How roles and permissions work</span>
        <ChevronDownIcon size={14} className="chev ml-auto" />
      </summary>

      <div className="admin-guide__body">
        <p className="admin-guide__intro">
          Everyone who uses the app has one role, and a role is a set of ticked boxes: a row for
          each part of the app, and a box for each thing that can be done there. The Users tab
          decides who has which role. Roles & permissions decides what each role may do.
        </p>

        <div className="admin-guide__cols">
          <section>
            <h2 className="section-title">Set up a role</h2>
            {/* Numbered because it is an order: a role has to exist, with its
                boxes saved, before it is worth giving to anyone. */}
            <ol className="admin-guide__steps">
              <li>
                Pick a role on <b>Roles & permissions</b>, or press <b>New role</b> to make one.
                For a new role, a copy of Viewer is the safe start: out of the box it can open
                every screen except this one, and change nothing.
              </li>
              <li>Tick what the role may do. Hover over a box to see exactly what it allows.</li>
              <li>
                Press <b>Save changes</b>. It applies straight away, and anyone with the role who
                already has the app open sees it once they reload the page.
              </li>
              <li>
                Open <b>Users</b> and pick the role in the dropdown beside each person who should
                have it.
              </li>
              {showViewAs && (
                <li>
                  Check it with <b>View as</b>, under your name in the sidebar. Pick the role to
                  see every screen the way it does, then pick Admin (everything) to come back.
                  View as is only there while sign-in is switched off for testing.
                </li>
              )}
            </ol>
          </section>

          <section>
            <h2 className="section-title">What each box means</h2>
            <dl className="admin-guide__boxes">
              {ACTIONS.map((action) => (
                <Fragment key={action}>
                  <dt>{ACTION_LABELS[action]}</dt>
                  <dd>{WHAT_EACH_BOX_MEANS[action]}</dd>
                </Fragment>
              ))}
            </dl>
            <p className="help mt-2.5">
              A blank cell means that part of the app has nothing of that kind to allow.
            </p>
          </section>
        </div>

        <section>
          <h2 className="section-title">Good to know</h2>
          <ul className="admin-guide__notes">
            <li>
              <b>Viewer</b>, <b>Editor</b> and <b>Admin</b> come built in and {"can't"} be
              deleted. Viewer and Editor can be changed, and <b>Reset to default</b> puts either
              one back the way it started.
            </li>
            <li>
              {"Admin always has every box and can't be edited, so nobody can lock every admin " +
                "out of this page. The Users and Roles & permissions rows belong to Admin alone: " +
                "on every other role they read “Admins only”, so no role can make itself an admin."}
            </li>
            <li>
              Ticking any box ticks Read too, because nothing in a feature can be reached without
              opening it. Unticking Read clears the whole row.
            </li>
            <li>
              <b>Delete role</b> removes a role an admin made. It stays switched off while anyone
              has the role, so give those people another role on the Users tab first.
            </li>
            <li>
              Every change is listed under <b>Recent changes</b> at the bottom of Roles &
              permissions, with who made it and when.
            </li>
            <li>
              The server checks the same boxes as the screens, so nobody can get round a box by
              going another way.
            </li>
          </ul>
        </section>
      </div>
    </details>
  );
}
