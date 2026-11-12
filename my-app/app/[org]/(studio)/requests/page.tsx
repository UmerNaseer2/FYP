"use client";

import "@/app/styles/atelier-requests.css";
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button, Card, ConfirmDialog, Pill, Skeleton, type PillTone } from "@/components/ui";
import { Select } from "@/components/ui/Select";
import { AlertTriangleIcon, CheckIcon, InboxIcon, XIcon } from "@/components/ui/icons";
import { HelpHint } from "@/components/ui/HelpHint";
import { PageHeader } from "@/components/studio/PageHeader";
import { PillTabs, type PillTab } from "@/components/studio/PillTabs";
import { useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import {
  REQUEST_TEXT_MAX,
  REQUESTS_CHANGED_EVENT,
  type AccessRequest,
  type InboxRequest,
  type RequestAnswer,
  type RequestsPayload,
} from "@/lib/access-requests";
import { apiFetch } from "@/lib/api-fetch";
import type { ListedApproval } from "@/lib/approvals-db";
import {
  deployHref,
  describeAsked,
  formatWhen,
  ownRunStory,
  runTarget,
  runTitle,
  STATUS_PILLS,
} from "@/lib/request-wording";
import {
  ADMIN_ROLE,
  isAdminOnly,
  isPermissionKey,
  permissionLabel,
  PERMISSIONS,
  withToggled,
  type PermissionKey,
} from "@/lib/permissions";

/**
 * Requests: ask for something your role can't do, see what is waiting on you,
 * and read the answers. See lib/access-requests.ts for how it fits together.
 *
 * Answering "allow" calls the same Roles and Users routes the Admin page uses,
 * and only then records the answer, so their guards and audit trail still apply
 * and a refusal from them leaves the request waiting.
 *
 * The page has three tabs. "Needs you" holds what is waiting on the reader,
 * "You asked" holds what they asked for that is still open, and "Done" holds
 * the answers. All three stay mounted, so a half-written note is still there
 * when the reader comes back to its tab.
 */

/** The choice in the form for a request that is not one box in the grid. */
const SOMETHING_ELSE = "something-else";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * A role the person asking could move to. `includes` says whether it holds what they
 * asked for, and is null when the roles could not be read, as only an Admin may read them.
 */
type MoveOption = { value: string; label: string; roleLabel: string; includes: boolean | null };

type RoleRow = {
  name: string;
  label: string;
  userCount: number;
  permissions: PermissionKey[];
};

async function errorFrom(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rq-error" role="alert">
      <AlertTriangleIcon size={15} />
      <span>{children}</span>
    </div>
  );
}

/** The little line under a title saying who and when. */
function Meta({ children }: { children: ReactNode }) {
  return <p className="rq-meta">{children}</p>;
}

/** Two letters for the round badge beside a person's request. */
function initialsOf(who: string): string {
  const words = who.split("@")[0].split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : who.slice(0, 2);
  return letters.toUpperCase();
}

/** The round mark at the start of a Done row: a tick, a cross, or a dash. */
function ToneIcon({ tone }: { tone: PillTone }) {
  return (
    <span className="rq-ico" data-tone={tone} aria-hidden>
      {tone === "sync" ? <CheckIcon size={13} /> : tone === "break" ? <XIcon size={13} /> : "-"}
    </span>
  );
}

function EmptyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="rq-empty">
      <span className="rq-ico" data-tone="sync" aria-hidden>
        <InboxIcon size={22} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
    </Card>
  );
}

function TextBox({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  /** For a box with no visible label of its own. */
  label?: string;
}) {
  return (
    <textarea
      id={id}
      className="rq-ta"
      rows={2}
      maxLength={REQUEST_TEXT_MAX}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

function AskForm({ onSent }: { onSent: () => void }) {
  const { can, roleLabel } = useUser();
  const searchParams = useSearchParams();
  const linked = searchParams.get("ask");

  const askable = useMemo(
    () => PERMISSIONS.filter((entry) => !isAdminOnly(entry.key) && !can(entry.key)),
    [can]
  );
  const options = [
    ...askable.map((entry) => ({
      value: entry.key as string,
      label: permissionLabel(entry.key),
    })),
    { value: SOMETHING_ELSE, label: "Something else" },
  ];

  // A link from a page that refused something arrives with that thing picked.
  const [choice, setChoice] = useState(() =>
    askable.some((entry) => entry.key === linked) ? (linked as string) : ""
  );
  // That page may be out of date: the answer could already have arrived.
  const alreadyHeld = linked !== null && isPermissionKey(linked) && can(linked);

  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const somethingElse = choice === SOMETHING_ELSE;
  const ready = choice !== "" && (!somethingElse || message.trim() !== "");

  /** What was said about the last request is not about this one. */
  function pick(value: string) {
    setChoice(value);
    setSent(null);
    setError(null);
  }

  async function send() {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const response = await apiFetch("/api/requests", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ permission: somethingElse ? null : choice, message }),
      });
      if (!response.ok) {
        setError(await errorFrom(response, "Could not send your request."));
        return;
      }
      const body = await response.json().catch(() => null);
      setSent(
        body?.already
          ? "You already asked for this, and it is still waiting."
          : "Sent. It is under You asked, and the answer will show under Done."
      );
      setChoice("");
      setMessage("");
      onSent();
    } catch {
      setError("Could not send your request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="rq-ask">
      <h2>Ask for something</h2>
      <div className="rq-fld">
        <div>
          <label htmlFor="request-what">What do you need?</label>
          <HelpHint label="What do you need?">
            {"The list holds what your role can't do yet and an Admin could give. " +
              "Your request goes to the people here who can change roles or users."}
          </HelpHint>
        </div>
        <Select
          id="request-what"
          variant="input"
          ariaLabel="What do you need?"
          placeholder="Choose what your role can't do yet"
          value={choice}
          options={options}
          onChange={pick}
          disabled={busy}
        />
      </div>
      {alreadyHeld && (
        <p>
          {`Your role (${roleLabel}) can already ${describeAsked(linked).does ?? "do that"}. Reload the page you came from to use it.`}
        </p>
      )}

      <div className="rq-fld">
        <div>
          <label htmlFor="request-why">{somethingElse ? "Say what you need" : "Why? (optional)"}</label>
        </div>
        <TextBox
          id="request-why"
          value={message}
          onChange={setMessage}
          disabled={busy}
          placeholder={
            somethingElse
              ? "For example: I need a role between Viewer and Editor."
              : "A sentence helps whoever answers."
          }
        />
      </div>

      <Button variant="primary" disabled={!ready || busy} onClick={() => void send()}>
        {busy ? "Sending..." : "Send request"}
      </Button>
      {sent && <p role="status">{sent}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

function InboxRow({ request, onChanged }: { request: InboxRequest; onChanged: () => void }) {
  const { can } = useUser();
  const orgPath = useOrgHref();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the role has been read fresh, which opens the confirmation.
  const [widening, setWidening] = useState<RoleRow | null>(null);
  // Set once the roles this person could move to have been read.
  const [moveOptions, setMoveOptions] = useState<MoveOption[] | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const moving = moveOptions?.find((option) => option.value === moveTo);

  const who = request.requested_by_name || request.requested_by;
  const asked = describeAsked(request.permission);
  const key =
    request.permission !== null && isPermissionKey(request.permission)
      ? request.permission
      : null;
  const stillHere = request.member_id !== null;
  const mayWiden =
    key !== null && stillHere && request.member_role !== ADMIN_ROLE && can("roles:update");
  const mayMove = key !== null && stillHere && can("users:update");

  /** Records the answer. `changed` says a role was changed first, which a failure here does not undo. */
  async function answer(value: RequestAnswer, changed = false) {
    const response = await apiFetch(`/api/requests/${request.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: "answer", answer: value, note }),
    });
    if (!response.ok) {
      const why = await errorFrom(response, "Could not save your answer.");
      setError(changed ? `The change was made, but this still shows as waiting. ${why}` : why);
      if (response.status === 409) onChanged();
      return;
    }
    onChanged();
  }

  async function working(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Reads the role fresh, so the confirmation is about what it holds right now. */
  const startWidening = () =>
    working(async () => {
      const response = await apiFetch("/api/admin/roles");
      if (!response.ok) {
        setError(await errorFrom(response, "Could not read the roles."));
        return;
      }
      const roles: RoleRow[] = (await response.json())?.roles ?? [];
      const role = roles.find((entry) => entry.name === request.member_role);
      if (!role) {
        setError("That role no longer exists. Reload the page.");
        return;
      }
      setWidening(role);
    });

  const confirmWidening = () =>
    working(async () => {
      if (!key || !widening) return;
      const role = widening;
      setWidening(null);
      let changed = false;
      if (!role.permissions.includes(key)) {
        const response = await apiFetch("/api/admin/roles", {
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            role: role.name,
            permissions: withToggled(role.permissions, key, true),
          }),
        });
        if (!response.ok) {
          setError(await errorFrom(response, "Could not change the role."));
          return;
        }
        changed = true;
      }
      await answer("allowed", changed);
    });

  /** Offers the roles the viewer may hand out, marking those that would answer this. */
  const startMoving = () =>
    working(async () => {
      if (!key) return;
      const [usersResponse, rolesResponse] = await Promise.all([
        apiFetch("/api/admin/users"),
        apiFetch("/api/admin/roles"),
      ]);
      if (!usersResponse.ok) {
        setError(await errorFrom(usersResponse, "Could not read the roles you can hand out."));
        return;
      }
      const offered: { name: string; label: string; assignable: boolean }[] =
        (await usersResponse.json())?.roles ?? [];
      // Only for the hint below, so a role that may not read the grid just goes without it.
      const held: RoleRow[] = rolesResponse.ok ? (await rolesResponse.json())?.roles ?? [] : [];
      setMoveOptions(
        offered
          .filter((role) => role.assignable && role.name !== request.member_role)
          .map((role) => {
            const entry = held.find((row) => row.name === role.name);
            const includes = entry ? entry.permissions.includes(key) : null;
            return {
              value: role.name,
              label: includes ? `${role.label} (includes this)` : role.label,
              roleLabel: role.label,
              includes,
            };
          })
      );
      setMoveTo("");
    });

  const confirmMoving = () =>
    working(async () => {
      const response = await apiFetch("/api/admin/users", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ userId: request.member_id, role: moveTo }),
      });
      if (!response.ok) {
        setError(await errorFrom(response, "Could not change their role."));
        return;
      }
      setMoveOptions(null);
      // They will read this answer, so it only says allowed when the new role really holds it.
      await answer(moving?.includes ? "allowed" : "done", true);
    });

  const roleLabel = request.member_role_label ?? request.member_role;

  return (
    <Card className="rq-card">
      <div className="rq-top">
        <span className="rq-av" aria-hidden>
          {initialsOf(who)}
        </span>
        <div>
          <h2>{asked.title}</h2>
          <Meta>
            {`${who}${who === request.requested_by ? "" : ` (${request.requested_by})`}, `}
            {stillHere ? `currently ${roleLabel}. ` : "who has left this organization. "}
            {`Asked ${formatWhen(request.created_at)}.`}
          </Meta>
        </div>
        <Pill tone="pending">Request</Pill>
      </div>
      {request.message && (
        <blockquote className="rq-quote">
          <small>{`${who} wrote`}</small>
          {request.message}
        </blockquote>
      )}

      <TextBox
        id={`request-note-${request.id}`}
        value={note}
        onChange={setNote}
        disabled={busy}
        placeholder={`A note to ${who} (optional)`}
        label={`A note to ${who} (optional)`}
      />

      <div className="rq-act">
        {mayWiden && (
          <Button variant="primary" disabled={busy} onClick={() => void startWidening()}>
            {`Allow for everyone who is ${roleLabel}`}
          </Button>
        )}
        {mayMove && (
          <Button variant="secondary" disabled={busy} onClick={() => void startMoving()}>
            {`Give ${who} another role`}
          </Button>
        )}
        <Button variant="secondary" disabled={busy} onClick={() => void working(() => answer("done"))}>
          Mark as done
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void working(() => answer("declined"))}>
          Decline
        </Button>
        {mayWiden && (
          <HelpHint label="Something in between" className="self-center">
            For something in between, make a new role on the{" "}
            <Link href={orgPath("/admin")} className="underline underline-offset-2">
              Admin page
            </Link>
            , give it to them there, then mark this as done.
          </HelpHint>
        )}
      </div>

      {moveOptions && (
        <div className="rq-move">
          <div>
            <Select
              variant="input"
              ariaLabel={`New role for ${who}`}
              placeholder="Choose a role"
              value={moveTo}
              options={moveOptions}
              onChange={setMoveTo}
              disabled={busy}
            />
          </div>
          <Button variant="primary" disabled={busy || moveTo === ""} onClick={() => void confirmMoving()}>
            {moving?.includes ? "Change role and allow" : "Change role"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setMoveOptions(null)}>
            Cancel
          </Button>
          {moving && !moving.includes && (
            <p>
              {moving.includes === false
                ? `${moving.roleLabel} does not include "${asked.title}", so this is marked as done, not allowed.`
                : "This also marks the request as done."}
            </p>
          )}
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}


      <ConfirmDialog
        open={widening !== null}
        onClose={() => setWidening(null)}
        onConfirm={() => void confirmWidening()}
        title={widening ? `Change the ${widening.label} role?` : "Change this role?"}
        confirmLabel={key && widening?.permissions.includes(key) ? "Mark as allowed" : "Allow"}
        description={
          key && widening?.permissions.includes(key)
            ? `${widening.label} can already do this, so nothing changes. This only tells ${who} it is sorted.`
            : widening &&
              `Everyone who is ${widening.label} (${widening.userCount} ${
                widening.userCount === 1 ? "person" : "people"
              }) will be able to ${asked.does}. You can take it away again on the Admin page.`
        }
      />
    </Card>
  );
}

/** A production run that needs someone. Deciding happens on Deploy, with the SQL in view. */
function RunRow({ run, kind }: { run: ListedApproval; kind: "approve" | "run" }) {
  const { can } = useUser();
  const orgPath = useOrgHref();
  return (
    <Card className="rq-card">
      <div className="rq-top">
        <span className="rq-av" aria-hidden>
          {initialsOf(run.requested_by)}
        </span>
        <div>
          <h2>{runTitle(run)}</h2>
          <Meta>{`Asked for by ${run.requested_by}, ${formatWhen(run.requested_at)}.`}</Meta>
        </div>
        {kind === "approve" ? (
          <Pill tone="pending">Needs approval</Pill>
        ) : (
          <Pill tone="sync">Ready to run</Pill>
        )}
      </div>
      <div className="rq-line">{runTarget(run)}</div>
      {kind === "run" && run.decided_by && (
        <div className="rq-line">
          {`Approved by ${run.decided_by}.`}
          {run.expires_at ? ` Good until ${formatWhen(run.expires_at)}.` : ""}
        </div>
      )}
      {run.action === "revert" && (
        <div className="rq-line rq-line--strong">
          On Deploy, use &quot;Roll back to&quot; on this target. The approval is waiting there.
        </div>
      )}
      {can("deploy:read") && (
        <div className="rq-act">
          <Link href={orgPath(deployHref(run))} className="btn btn-primary">
            {kind === "approve" ? "Review it on Deploy" : "Open it on Deploy"}
          </Link>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Your own
// ---------------------------------------------------------------------------

/** True when an answer arrived after the reader last looked at this page. */
function isNew(decidedAt: string | null, since: string | null): boolean {
  if (!decidedAt) return false;
  return !since || new Date(decidedAt) > new Date(since);
}

/** True while a run of yours is still going somewhere: waiting, or approved and in time. */
function runIsOpen(run: ListedApproval): boolean {
  if (run.status === "pending") return true;
  if (run.status !== "approved") return false;
  return !run.expires_at || new Date(run.expires_at).getTime() > Date.now();
}

/** A request of yours that nobody has answered yet. */
function OwnRequestCard({ request, onChanged }: { request: AccessRequest; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = describeAsked(request.permission);
  const pill = STATUS_PILLS[request.status];

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/requests/${request.id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ action: "withdraw" }),
      });
      if (!response.ok) setError(await errorFrom(response, "Could not withdraw this."));
      else onChanged();
    } catch {
      setError("Could not withdraw this.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="rq-card">
      <div className="rq-top">
        <div>
          <h2>{asked.title}</h2>
          <Meta>{`Asked ${formatWhen(request.created_at)}.`}</Meta>
        </div>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>
      {request.message && (
        <blockquote className="rq-quote">
          <small>You wrote</small>
          {request.message}
        </blockquote>
      )}
      <div className="rq-act">
        <Button variant="ghost" disabled={busy} onClick={() => void withdraw()}>
          Withdraw
        </Button>
        <small>It is with the people here who can change roles or users.</small>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Card>
  );
}

/** A production run you asked for that is waiting, or approved and ready. */
function OwnRunCard({ run, since }: { run: ListedApproval; since: string | null }) {
  const { label, tone, story } = ownRunStory(run);
  const approved = run.status !== "pending";
  return (
    <Card className="rq-card">
      <div className="rq-top">
        <div>
          <h2>{runTitle(run)}</h2>
          <Meta>{`Asked ${formatWhen(run.requested_at)}.`}</Meta>
        </div>
        <Pill tone={tone}>{label}</Pill>
        {!run.self_approved && isNew(run.decided_at, since) && <Pill tone="brand">New</Pill>}
      </div>
      <div className="rq-line">{runTarget(run)}</div>
      <ol className="rq-steps" aria-label="Where this run has got to">
        <li data-s="done">
          <i aria-hidden>
            <CheckIcon size={10} />
          </i>
          Asked
        </li>
        <li data-s={approved ? "done" : "now"}>
          <i aria-hidden>
            <CheckIcon size={10} />
          </i>
          Approved
        </li>
        <li data-s={approved ? "now" : "todo"}>
          <i aria-hidden>
            <CheckIcon size={10} />
          </i>
          Run
        </li>
      </ol>
      <div className="rq-line rq-line--strong">{story}</div>
      {/* Not "their note": it stays the one you wrote unless the approver left another. */}
      {run.note && approved && <div className="rq-line">{`Note: ${run.note}`}</div>}
    </Card>
  );
}

/** A request of yours that has its answer, as one row of the Done list. */
function DoneRequestRow({ request, since }: { request: AccessRequest; since: string | null }) {
  const asked = describeAsked(request.permission);
  const pill = STATUS_PILLS[request.status];
  return (
    <div className="rq-row">
      <ToneIcon tone={pill.tone} />
      <div>
        <b>{asked.title}</b>
        {request.message && <p className="rq-said">{request.message}</p>}
        {request.status === "allowed" && <p>Reload the page you need it on, and you can use it.</p>}
        {request.decision_note && <p>{`Their note: ${request.decision_note}`}</p>}
        <Meta>
          {`Asked ${formatWhen(request.created_at)}.`}
          {request.decided_by
            ? ` Answered by ${request.decided_by}, ${formatWhen(request.decided_at)}.`
            : ""}
        </Meta>
      </div>
      <div className="rq-rt">
        <Pill tone={pill.tone}>{pill.label}</Pill>
        {isNew(request.decided_at, since) && <Pill tone="brand">New</Pill>}
      </div>
    </div>
  );
}

/** A production run of yours that is over: run, rejected, or out of time. */
function DoneRunRow({ run, since }: { run: ListedApproval; since: string | null }) {
  const { label, tone, story } = ownRunStory(run);
  return (
    <div className="rq-row">
      <ToneIcon tone={run.status === "used" ? "sync" : tone} />
      <div>
        <b>{runTitle(run)}</b>
        <p>{runTarget(run)}</p>
        <p>{story}</p>
        {run.note && <p>{`Note: ${run.note}`}</p>}
        <Meta>{`Asked ${formatWhen(run.requested_at)}.`}</Meta>
      </div>
      <div className="rq-rt">
        <Pill tone={tone}>{label}</Pill>
        {!run.self_approved && isNew(run.decided_at, since) && <Pill tone="brand">New</Pill>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type TabKey = "needs" | "asked" | "done";

function RequestsBody() {
  const orgPath = useOrgHref();
  const { isAdmin } = useUser();
  const [data, setData] = useState<RequestsPayload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The tab the reader picked. Null until they pick one, and the page then
  // opens on the first tab that has something in it.
  const [picked, setPicked] = useState<TabKey | null>(null);
  // Answers newer than this are marked New. Kept from the first read, because
  // reading the page moves the stored time on and the marks should stay until
  // the next visit. Undefined until then; null means never looked before.
  const [newSince, setNewSince] = useState<string | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch("/api/requests");
      if (!response.ok) {
        setFailed(await errorFrom(response, "Could not load requests."));
        return;
      }
      const next = (await response.json()) as RequestsPayload;
      setData(next);
      setFailed(null);
      setNewSince((current) => (current === undefined ? next.lastSeenAt : current));
      if (next.counts.answered > 0) {
        await apiFetch("/api/requests/seen", { method: "POST" });
        window.dispatchEvent(new Event(REQUESTS_CHANGED_EVENT));
      }
    } catch {
      setFailed("Could not load requests.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const changed = useCallback(() => {
    window.dispatchEvent(new Event(REQUESTS_CHANGED_EVENT));
    void load();
  }, [load]);

  const inbox = data?.inbox ?? [];
  const toApprove = data?.runsToApprove ?? [];
  const toRun = data?.runsToRun ?? [];
  const mine = data?.mine ?? [];
  const myRuns = data?.myRuns ?? [];
  const since = newSince ?? null;

  const openRequests = mine.filter((request) => request.status === "pending");
  const doneRequests = mine.filter((request) => request.status !== "pending");
  const openRuns = myRuns.filter(runIsOpen);
  const doneRuns = myRuns.filter((run) => !runIsOpen(run));

  const waitingCount = inbox.length + toApprove.length + toRun.length;
  const askedCount = openRequests.length + openRuns.length;
  const doneCount = doneRequests.length + doneRuns.length;
  const newCount =
    doneRequests.filter((request) => isNew(request.decided_at, since)).length +
    doneRuns.filter((run) => !run.self_approved && isNew(run.decided_at, since)).length;

  // "Nothing is waiting" is for the person who answers requests. Anyone else came here to
  // ask for something, and an empty tab would only be in the way.
  const showWaiting = Boolean(data?.canAnswer) || waitingCount > 0;
  // An Admin can do everything, so they have nothing to ask for. Their own
  // tabs show only when a production run of theirs is listed.
  const showOwn = !isAdmin || askedCount + doneCount > 0;

  const tabs: PillTab[] = [];
  if (showWaiting) tabs.push({ key: "needs", label: "Needs you", count: waitingCount });
  if (showOwn) {
    tabs.push({ key: "asked", label: "You asked", count: askedCount });
    tabs.push({ key: "done", label: "Done", count: newCount });
  }

  // Until the reader picks a tab, open on the one with something to read.
  let opening: TabKey = showWaiting ? "needs" : "asked";
  if (waitingCount === 0 && showOwn) {
    if (newCount > 0) opening = "done";
    else if (askedCount > 0) opening = "asked";
    else if (doneCount > 0) opening = "done";
  }
  const tab = picked !== null && tabs.some((entry) => entry.key === picked) ? picked : opening;

  return (
    <div className="rq-page">
      <PageHeader
        page="/requests"
        title="What needs you. What you asked for."
        actions={
          <Link href={orgPath("/phone")} className="btn btn-secondary btn-sm">
            Phone app
          </Link>
        }
      >
        {data && tabs.length > 0 && (
          <PillTabs
            label="Requests"
            tabs={tabs}
            value={tab}
            onChange={(key) => setPicked(key as TabKey)}
            idPrefix="requests-tab-"
            panelPrefix="requests-panel-"
          />
        )}
      </PageHeader>

      {failed && <ErrorNote>{failed}</ErrorNote>}

      {!data && !failed && (
        <div className="rq-main" aria-busy="true">
          <Skeleton width="100%" height={120} radius={24} />
          <Skeleton width="100%" height={120} radius={24} />
        </div>
      )}

      {data && (
        <div className={isAdmin ? "rq-grid" : "rq-grid rq-grid--side"}>
          <div className="rq-main">
            {showWaiting && (
              <section
                role="tabpanel"
                id="requests-panel-needs"
                aria-labelledby="requests-tab-needs"
                hidden={tab !== "needs"}
              >
                {waitingCount === 0 && (
                  <EmptyCard title="Nothing is waiting for you">
                    Requests and production runs that need you will show here.
                  </EmptyCard>
                )}
                {inbox.map((request) => (
                  <InboxRow key={request.id} request={request} onChanged={changed} />
                ))}
                {toApprove.map((run) => (
                  <RunRow key={run.id} run={run} kind="approve" />
                ))}
                {toRun.map((run) => (
                  <RunRow key={run.id} run={run} kind="run" />
                ))}
              </section>
            )}

            {showOwn && (
              <section
                role="tabpanel"
                id="requests-panel-asked"
                aria-labelledby="requests-tab-asked"
                hidden={tab !== "asked"}
              >
                {askedCount === 0 && (
                  <EmptyCard title="Nothing of yours is waiting">
                    {doneCount === 0
                      ? "You have not asked for anything here yet."
                      : "Everything you asked for has its answer. Look under Done."}
                  </EmptyCard>
                )}
                {openRequests.map((request) => (
                  <OwnRequestCard key={request.id} request={request} onChanged={changed} />
                ))}
                {openRuns.map((run) => (
                  <OwnRunCard key={run.id} run={run} since={since} />
                ))}
              </section>
            )}

            {showOwn && (
              <section
                role="tabpanel"
                id="requests-panel-done"
                aria-labelledby="requests-tab-done"
                hidden={tab !== "done"}
              >
                {doneCount === 0 ? (
                  <EmptyCard title="No answers yet">
                    When someone answers a request of yours, it shows here.
                  </EmptyCard>
                ) : (
                  <Card className="rq-list">
                    {doneRequests.map((request) => (
                      <DoneRequestRow key={request.id} request={request} since={since} />
                    ))}
                    {doneRuns.map((run) => (
                      <DoneRunRow key={run.id} run={run} since={since} />
                    ))}
                  </Card>
                )}
              </section>
            )}
          </div>

          {!isAdmin && <AskForm onSent={changed} />}
        </div>
      )}
    </div>
  );
}

// useSearchParams needs a Suspense boundary above it for the build to succeed.
export default function RequestsPage() {
  return (
    <Suspense fallback={null}>
      <RequestsBody />
    </Suspense>
  );
}
