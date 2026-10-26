"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button, Card, ConfirmDialog, Input, Label, Pill } from "@/components/ui";
import { Select, type SelectOption } from "@/components/ui/Select";
import {
  AlertTriangleIcon,
  CheckIcon,
  ClipboardIcon,
  PlusIcon,
  RefreshIcon,
  XIcon,
} from "@/components/ui/icons";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import { apiFetch } from "@/lib/api-fetch";
import { shortUtcDate } from "@/lib/format-date";
import {
  DEFAULT_LINK_INVITE_DAYS,
  EMAIL_INVITE_DAYS,
  INVITE_EMAIL_MAX_LENGTH,
  LINK_INVITE_DAYS,
  LINK_INVITE_ROLE,
  cleanInviteEmail,
  inviteEmailProblem,
  inviteLink,
  isCreatedInvite,
  isInviteListing,
  isLinkInviteDays,
  type InviteListing,
  type LinkInviteDays,
  type PendingInvite,
} from "@/lib/invites";
import { BUILT_IN_ROLE_INFO, DEFAULT_ROLE } from "@/lib/permissions";

/**
 * "Invite people", under the member list on the Users tab (UsersTab.tsx),
 * for whoever may invite (Users: Create).
 *
 * Two ways in, as lib/invites.ts explains: an invitation to one email address,
 * with a role, or a link that lets anyone who has it join as a Viewer. Either
 * way the app sends nothing. Making one answers with its link, which this
 * panel shows once for the Admin to copy and send themselves: the server keeps
 * only a hash of it, so the link cannot be shown again later. Below the forms
 * are the invitations still waiting to be taken, each of which can be
 * cancelled.
 *
 * The server says whether anyone can be invited here at all (`canInvite`):
 * not in the desktop app, which keeps one organization of its own, and not in
 * the demo, where nobody signs in to take an invitation. The panel draws
 * nothing in those, rather than forms that could only be refused.
 */

const UNREACHABLE = "Could not reach the server. Check your connection, then try again.";

/** What a form's last attempt came to, under the box it is about or for the form as a whole. */
type EmailProblems = { email?: string; role?: string; form?: string };
type LinkProblems = { days?: string; form?: string };

/** An invitation just made: the one moment its link exists outside the database. */
type Made = { invite: PendingInvite; link: string };

const DAYS_OPTIONS: SelectOption[] = LINK_INVITE_DAYS.map((days) => ({
  value: String(days),
  label: days === 1 ? "1 day" : `${days} days`,
}));

export function InvitePanel({ active, options }: { active: boolean; options: SelectOption[] }) {
  const [listing, setListing] = useState<InviteListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>(DEFAULT_ROLE);
  const [emailProblems, setEmailProblems] = useState<EmailProblems>({});
  const [days, setDays] = useState<LinkInviteDays>(DEFAULT_LINK_INVITE_DAYS);
  const [linkProblems, setLinkProblems] = useState<LinkProblems>({});
  const [making, setMaking] = useState<"email" | "link" | null>(null);
  const [made, setMade] = useState<Made | null>(null);

  const [cancelTarget, setCancelTarget] = useState<PendingInvite | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const emailInput = useRef<HTMLInputElement>(null);
  const ids = useId();
  const emailId = `${ids}-email`;
  const roleId = `${ids}-role`;
  const daysId = `${ids}-days`;

  // Counts every load, as on the member list above: a list whose number is no
  // longer the latest when it arrives is thrown away, because a newer load
  // overtook it. Changes are not counted, unlike there: every invitation made
  // or cancelled is followed by a load of its own, whose number throws away
  // any list asked for before the change, and a refused one changed nothing.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    let response: Response;
    try {
      response = await apiFetch("/api/admin/invites", { cache: "no-store" });
    } catch {
      if (mine === latest.current) setListError(UNREACHABLE);
      return;
    }
    const body = await jsonOf(response);
    if (mine !== latest.current) return;
    if (!response.ok) {
      setListError(errorFrom(body) ?? `Could not load the invitations (HTTP ${response.status}).`);
      return;
    }
    if (!isInviteListing(body)) {
      setListError("The server's answer about invitations could not be read.");
      return;
    }
    setListing(body);
    setListError(null);
  }, []);

  // Loaded on every visit to the tab, like the member list: an invitation
  // taken or cancelled in the meantime should not still be listed.
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  async function makeEmailInvite(event: FormEvent) {
    event.preventDefault();
    if (making) return;
    const address = cleanInviteEmail(email);
    const problem = inviteEmailProblem(address);
    if (problem) {
      setEmailProblems({ email: problem });
      emailInput.current?.focus();
      return;
    }
    setEmailProblems({});
    const answer = await make("email", { kind: "email", email: address, role });
    if (answer.made) {
      setEmail("");
    } else if (answer.field === "email" || answer.field === "role") {
      setEmailProblems({ [answer.field]: answer.message });
      if (answer.field === "email") emailInput.current?.focus();
    } else {
      setEmailProblems({ form: answer.message });
    }
  }

  async function makeLinkInvite(event: FormEvent) {
    event.preventDefault();
    if (making) return;
    setLinkProblems({});
    const answer = await make("link", { kind: "link", days });
    if (answer.made) return;
    setLinkProblems(answer.field === "days" ? { days: answer.message } : { form: answer.message });
  }

  /**
   * Asks the server for an invitation and, when it makes one, puts its link
   * on screen. A refusal comes back with the field it is about, when the
   * server named one, for the form to put under that box.
   */
  async function make(
    which: "email" | "link",
    request: Record<string, unknown>
  ): Promise<{ made: true } | { made: false; message: string; field: string | null }> {
    setMaking(which);
    try {
      let response: Response;
      try {
        response = await apiFetch("/api/admin/invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
      } catch {
        return { made: false, message: UNREACHABLE, field: null };
      }
      const body = await jsonOf(response);
      if (response.ok) {
        // Made either way, so the list is reloaded either way. Without a token
        // in the answer there is no link to show, and the only way to get one
        // is to make the invitation again.
        void load();
        if (isCreatedInvite(body)) {
          setMade({ invite: body.invite, link: inviteLink(window.location.origin, body.token) });
          return { made: true };
        }
        return {
          made: false,
          message:
            "The invitation was made, but the server's answer could not be read, so its link " +
            "cannot be shown. Cancel it below and make a new one.",
          field: null,
        };
      }
      const field = (body as { field?: unknown } | null)?.field;
      return {
        made: false,
        message: errorFrom(body) ?? `Could not make the invitation (HTTP ${response.status}).`,
        field: typeof field === "string" ? field : null,
      };
    } finally {
      setMaking(null);
    }
  }

  async function confirmCancel() {
    if (!cancelTarget) return;
    const target = cancelTarget;
    setCancelling(target.id);
    setCancelError(null);
    try {
      const response = await apiFetch("/api/admin/invites", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.id }),
      });
      if (response.ok) {
        setListing((now) =>
          now ? { ...now, invites: now.invites.filter((invite) => invite.id !== target.id) } : now
        );
        // The link on screen is for an invitation that no longer works.
        setMade((now) => (now?.invite.id === target.id ? null : now));
      } else {
        const body = await jsonOf(response);
        setCancelError(
          errorFrom(body) ?? `Could not cancel the invitation (HTTP ${response.status}).`
        );
      }
    } catch {
      setCancelError(UNREACHABLE);
    } finally {
      setCancelling(null);
      setCancelTarget(null);
    }
    // Cancelled or refused, the list is reloaded: a refusal usually means it
    // was taken or cancelled by someone else, and the list should say so.
    void load();
  }

  // Nothing until the server has said whether invitations work here, and
  // nothing at all where they do not.
  if (!listing && !listError) return null;
  if (listing && !listing.canInvite) return null;

  const viewerLabel =
    options.find((option) => option.value === LINK_INVITE_ROLE)?.label ??
    BUILT_IN_ROLE_INFO[LINK_INVITE_ROLE].label;

  return (
    <Card className="mt-6 p-4 sm:p-5">
      <h2 className="text-[15px] font-semibold">Invite people</h2>
      <p className="help mt-0.5">
        Make an invitation here, then send its link to the person yourself. The app does not send
        email.
      </p>

      {!listing ? (
        <ListError message={listError ?? ""} onRetry={() => void load()} />
      ) : (
        <>
          {/* Keyed on the link, so a newer invitation gets a box of its own,
              Copy and all, rather than the last one's "Copied". */}
          {made && <MadeInvite key={made.link} made={made} onDone={() => setMade(null)} />}

          <form className="mt-4" onSubmit={(event) => void makeEmailInvite(event)} noValidate>
            <h3 className="section-title">To an email address</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px_auto] sm:items-end">
              <div>
                <Label htmlFor={emailId} className="mb-1 block">
                  Email address
                </Label>
                <Input
                  ref={emailInput}
                  id={emailId}
                  type="email"
                  inputMode="email"
                  value={email}
                  maxLength={INVITE_EMAIL_MAX_LENGTH}
                  placeholder="name@example.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  readOnly={making !== null}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={emailProblems.email ? true : undefined}
                  aria-describedby={emailProblems.email ? `${emailId}-problem` : `${emailId}-help`}
                />
              </div>
              <div>
                <Label htmlFor={roleId} className="mb-1 block">
                  Role
                </Label>
                <Select
                  id={roleId}
                  variant="input"
                  value={role}
                  options={options}
                  disabled={making !== null}
                  onChange={setRole}
                />
              </div>
              <Button variant="primary" type="submit" disabled={making !== null}>
                {making === "email" ? (
                  "Making…"
                ) : (
                  <>
                    <PlusIcon size={14} /> Make invitation
                  </>
                )}
              </Button>
            </div>
            {emailProblems.email && (
              <p id={`${emailId}-problem`} className="field-problem mt-1.5">
                {emailProblems.email}
              </p>
            )}
            {emailProblems.role && <p className="field-problem mt-1.5">{emailProblems.role}</p>}
            <p id={`${emailId}-help`} className="help mt-1.5">
              Only someone who signs in with this address can take it, once, within{" "}
              {EMAIL_INVITE_DAYS} days.
            </p>
            {emailProblems.form && <FormProblem message={emailProblems.form} />}
          </form>

          <form className="mt-5" onSubmit={(event) => void makeLinkInvite(event)} noValidate>
            <h3 className="section-title">As a link</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-[170px_auto] sm:justify-start sm:items-end">
              <div>
                <Label htmlFor={daysId} className="mb-1 block">
                  Lasts
                </Label>
                <Select
                  id={daysId}
                  variant="input"
                  value={String(days)}
                  options={DAYS_OPTIONS}
                  disabled={making !== null}
                  onChange={(value) => {
                    const picked = Number(value);
                    if (isLinkInviteDays(picked)) setDays(picked);
                  }}
                />
              </div>
              <Button type="submit" disabled={making !== null}>
                {making === "link" ? (
                  "Making…"
                ) : (
                  <>
                    <PlusIcon size={14} /> Make link
                  </>
                )}
              </Button>
            </div>
            {linkProblems.days && <p className="field-problem mt-1.5">{linkProblems.days}</p>}
            <p className="help mt-1.5">
              Anyone who has the link can join as a {viewerLabel} until it runs out or is
              cancelled, so send it only to people you mean to let in.
            </p>
            {linkProblems.form && <FormProblem message={linkProblems.form} />}
          </form>

          <div className="mt-5">
            <h3 className="section-title">Waiting to be taken</h3>
            {listError && <FormProblem message={listError} />}
            {cancelError && <FormProblem message={cancelError} />}
            {listing.invites.length === 0 ? (
              <p className="help mt-2">No invitations are waiting.</p>
            ) : (
              <ul className="mt-1">
                {listing.invites.map((invite) => (
                  <PendingRow
                    key={invite.id}
                    invite={invite}
                    cancelling={cancelling === invite.id}
                    disabled={cancelling !== null}
                    onCancel={() => setCancelTarget(invite)}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* As on the member list, the row carries the wait ("Cancelling…"): the
          dialog closes the moment it is confirmed. */}
      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => void confirmCancel()}
        destructive
        title={
          cancelTarget?.email
            ? `Cancel the invitation for ${cancelTarget.email}?`
            : "Cancel this invitation link?"
        }
        description={
          cancelTarget?.email
            ? "The link you sent stops working at once. You can invite them again later."
            : "The link stops working at once. Anyone who already joined with it stays a member."
        }
        confirmLabel="Cancel invitation"
        cancelLabel="Keep it"
      />
    </Card>
  );
}

/**
 * The link of an invitation just made, with Copy.
 *
 * Copying needs the browser's clipboard, which it only offers on a secure
 * page (https, or localhost). Anywhere else, or when the browser says no, the
 * link is selected in its box instead, ready to copy by hand.
 */
function MadeInvite({ made, onDone }: { made: Made; onDone: () => void }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const linkBox = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const headingId = useId();

  // Focus moves to Copy, which is what to do next.
  useEffect(() => {
    copyButton.current?.focus();
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(made.link);
      setCopy("copied");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopy("idle"), 1500);
    } catch {
      linkBox.current?.focus();
      linkBox.current?.select();
      setCopy("failed");
    }
  }

  const { invite } = made;
  return (
    <section
      className="role-note mt-4 flex-col"
      aria-labelledby={headingId}
      style={{ gap: 8 }}
    >
      <div id={headingId} className="title">
        {invite.email
          ? `Invitation for ${invite.email}, as ${invite.roleLabel}`
          : `Invitation link, as ${invite.roleLabel}, until ${shortUtcDate(invite.expiresAt)}`}
      </div>
      <div className="flex items-center gap-2">
        <Input
          ref={linkBox}
          mono
          readOnly
          value={made.link}
          aria-label="Invitation link"
          className="flex-1 min-w-0"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button ref={copyButton} size="sm" onClick={() => void copyLink()}>
          {copy === "copied" ? (
            <>
              <CheckIcon size={14} /> Copied
            </>
          ) : (
            <>
              <ClipboardIcon size={14} /> Copy link
            </>
          )}
        </Button>
      </div>
      <div className="body text-[12.5px]">
        {copy === "failed"
          ? "The browser did not let the page copy it, so the link is selected: copy it from the box. "
          : ""}
        This is the only time the link is shown. Copy it now and send it yourself.
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

/** One invitation still waiting, with Cancel. */
function PendingRow({
  invite,
  cancelling,
  disabled,
  onCancel,
}: {
  invite: PendingInvite;
  cancelling: boolean;
  disabled: boolean;
  onCancel: () => void;
}) {
  const until = shortUtcDate(invite.expiresAt);
  return (
    <li
      className="py-3 flex items-center gap-3 flex-wrap"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13.5px] font-medium truncate">
            {invite.email ?? "Invitation link"}
          </span>
          <Pill dot={false}>{invite.roleLabel}</Pill>
        </div>
        <div className="help mt-0.5">
          Lasts until {until}
          {invite.invitedBy && <> · made by {invite.invitedBy}</>}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onCancel}
        aria-label={
          invite.email
            ? `Cancel the invitation for ${invite.email}`
            : `Cancel the invitation link that lasts until ${until}`
        }
      >
        {cancelling ? (
          "Cancelling…"
        ) : (
          <>
            <XIcon size={14} /> Cancel
          </>
        )}
      </Button>
    </li>
  );
}

/** A refusal or failure that belongs to a form or the list as a whole. */
function FormProblem({ message }: { message: string }) {
  return (
    <div className="banner mt-3" role="alert">
      <AlertTriangleIcon size={16} className="ico" />
      <div className="body">{message}</div>
    </div>
  );
}

/** The panel when the first list could not be loaded: why, and Retry. */
function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-4 flex items-start gap-3 flex-wrap">
      <div className="flex-1 min-w-0">
        <FormProblem message={message} />
      </div>
      <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
        <RefreshIcon size={14} /> Retry
      </Button>
    </div>
  );
}
