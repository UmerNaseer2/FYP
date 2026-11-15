"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon, EditIcon, EyeIcon, ShieldIcon, XIcon } from "@/components/ui/icons";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { TRIAL_PEOPLE, TRIAL_ROLES, TRIAL_ROLE_SUMMARY, type TrialRole } from "@/lib/trial-rules";

// The landing page's "Try it now" button and the role picker it opens.
//
// "Try it now" asks first: it opens a dialog with one card for each trial
// account (Trial Admin, Trial Editor, Trial Viewer), and the card pressed
// posts to app/api/trial/route.ts, which signs the visitor in as that account.
// Before the page's script has run, the button is a plain form button and
// posts on its own, as the Trial Admin, so the trial opens either way.
//
// The dialog sits in document.body so nothing on the page clips it. Escape,
// the close button and a press outside the panel close it. On a phone it is a
// sheet that rises from the bottom (app/styles/atelier-landing.css, lp-pick).
// Inside the trial, the account menu at the top right switches role
// (components/studio/AccountMenu.tsx).

const ROLE_ICON: Record<TrialRole, typeof ShieldIcon> = {
  admin: ShieldIcon,
  editor: EditIcon,
  viewer: EyeIcon,
};

export function TrialRolePicker({ action }: { action: string }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState<TrialRole | null>(null);
  const sendingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const leadId = useId();

  useDialogFocus(open, panelRef);

  // The page behind does not scroll while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, [open]);

  // Back from the studio with the browser's Back button, the page comes back
  // as it was left: closed, and ready to be pressed again.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sendingRef.current = false;
      setSending(null);
      setOpen(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  function close() {
    if (sendingRef.current) return;
    setOpen(false);
  }

  function choose(event: MouseEvent<HTMLButtonElement>, role: TrialRole) {
    // One press signs in. A second press while the first is on its way does nothing.
    if (sendingRef.current) {
      event.preventDefault();
      return;
    }
    sendingRef.current = true;
    setSending(role);
  }

  return (
    <>
      <form action={action} method="post" className="lp-try">
        <button
          type="submit"
          name="role"
          value="admin"
          className="btn btn-primary btn-lg lp-try__btn"
          aria-label="Try it now, no account needed"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <span>Try it now</span>
          <small>No account needed</small>
        </button>
      </form>

      {open &&
        createPortal(
          <div
            className="lp-pick"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              ref={panelRef}
              className="lp-pick__panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={leadId}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                close();
              }}
            >
              <h2 id={titleId} className="lp-pick__title">
                Choose a role to try
              </h2>
              <p id={leadId} className="lp-pick__lead">
                One shared organization with example data, so others in it see what you change.
                Switch role any time from the account menu at the top right.
              </p>
              <form action={action} method="post" className="lp-pick__list">
                {TRIAL_ROLES.map((role) => {
                  const Icon = ROLE_ICON[role];
                  const summaryId = `${leadId}-${role}`;
                  return (
                    <button
                      key={role}
                      type="submit"
                      name="role"
                      value={role}
                      className="lp-pick__card"
                      data-role={role}
                      aria-label={`Try as ${TRIAL_PEOPLE[role].name}`}
                      aria-describedby={summaryId}
                      aria-busy={sending === role || undefined}
                      onClick={(event) => choose(event, role)}
                    >
                      <span className="lp-pick__ic" aria-hidden="true">
                        <Icon size={20} />
                      </span>
                      <span className="lp-pick__txt">
                        <b>
                          {TRIAL_PEOPLE[role].name}
                          {role === "admin" && <em className="lp-pick__tag">Sees the most</em>}
                        </b>
                        <span id={summaryId}>
                          {sending === role ? "Opening the trial…" : TRIAL_ROLE_SUMMARY[role].long}
                        </span>
                      </span>
                      <ChevronRightIcon size={18} className="lp-pick__go" aria-hidden="true" />
                    </button>
                  );
                })}
              </form>
              <button type="button" className="lp-pick__x" aria-label="Close" onClick={close}>
                <XIcon size={18} />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
