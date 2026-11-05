"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button, Card, ConfirmDialog, EmptyState, Pill, Skeleton } from "@/components/ui";
import { Select } from "@/components/ui/Select";
import { AlertTriangleIcon, InboxIcon } from "@/components/ui/icons";
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
    <div
      className="flex items-start gap-2 p-3 rounded-xl mt-3"
      role="alert"
      style={{
        background: "color-mix(in oklab, var(--break) 10%, transparent)",
        border: "1px solid color-mix(in oklab, var(--break) 30%, transparent)",
      }}
    >
      <AlertTriangleIcon size={15} style={{ color: "var(--break)", marginTop: 1, flex: "none" }} />
      <span className="text-[13px]" style={{ color: "var(--break)" }}>
        {children}
      </span>
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mt-8 mb-3">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {hint && (
        <p className="text-[12.5px] mt-0.5 max-w-[62ch]" style={{ color: "var(--text-2)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** The little line under a row saying who and when. */
function Meta({ children }: { children: ReactNode }) {
  return (
    <div className="text-[12px] mt-1" style={{ color: "var(--text-3)" }}>
      {children}
    </div>
  );
}

function TextBox({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <textarea
      id={id}
      className="input w-full"
      style={{ height: "auto", minHeight: 62, padding: "8px 10px", resize: "vertical" }}
      rows={2}
      maxLength={REQUEST_TEXT_MAX}
      value={value}
      placeholder={placeholder}
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
          : "Sent. The answer will show under Your requests, below."
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
    <Card className="p-4 sm:p-5 mt-6">
      <label htmlFor="request-what" className="text-[13px] font-medium">
        What do you need?
      </label>
      <div className="mt-1.5">
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
        <p className="text-[12.5px] mt-2" style={{ color: "var(--text-2)" }}>
          {`Your role (${roleLabel}) can already ${describeAsked(linked).does ?? "do that"}. Reload the page you came from to use it.`}
        </p>
      )}

      <label htmlFor="request-why" className="block text-[13px] font-medium mt-4">
        {somethingElse ? "Say what you need" : "Why? (optional)"}
      </label>
      <div className="mt-1.5">
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

      <div className="flex flex-wrap items-center gap-3 mt-4">
        <Button variant="primary" size="sm" disabled={!ready || busy} onClick={() => void send()}>
          {busy ? "Sending..." : "Send request"}
        </Button>
        <span className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
          Goes to the people here who can change roles or users.
        </span>
      </div>
      {sent && (
        <p className="text-[13px] mt-3" role="status" style={{ color: "var(--text-1)" }}>
          {sent}
        </p>
      )}
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
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{asked.title}</span>
        <Pill tone="pending">Request</Pill>
      </div>
      {request.message && (
        <p className="text-[13px] mt-2 whitespace-pre-wrap break-words">{request.message}</p>
      )}
      <Meta>
        {`${who}${who === request.requested_by ? "" : ` (${request.requested_by})`}, `}
        {stillHere ? `currently ${roleLabel}. ` : "who has left this organization. "}
        {`Asked ${formatWhen(request.created_at)}.`}
      </Meta>

      <div className="mt-3">
        <TextBox
          id={`request-note-${request.id}`}
          value={note}
          onChange={setNote}
          disabled={busy}
          placeholder={`A note to ${who} (optional)`}
        />
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        {mayWiden && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void startWidening()}>
            {`Allow for everyone who is ${roleLabel}`}
          </Button>
        )}
        {mayMove && (
          <Button size="sm" disabled={busy} onClick={() => void startMoving()}>
            {`Give ${who} another role`}
          </Button>
        )}
        <Button size="sm" disabled={busy} onClick={() => void working(() => answer("done"))}>
          Mark as done
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void working(() => answer("declined"))}
        >
          Decline
        </Button>
      </div>

      {moveOptions && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <div className="min-w-[220px]">
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
          <Button
            variant="primary"
            size="sm"
            disabled={busy || moveTo === ""}
            onClick={() => void confirmMoving()}
          >
            {moving?.includes ? "Change role and allow" : "Change role"}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMoveOptions(null)}>
            Cancel
          </Button>
          {moving && !moving.includes && (
            <p className="text-[12px] w-full" style={{ color: "var(--text-3)" }}>
              {moving.includes === false
                ? `${moving.roleLabel} does not include "${asked.title}", so this is marked as done, not allowed.`
                : "This also marks the request as done."}
            </p>
          )}
        </div>
      )}

      {mayWiden && (
        <p className="text-[12px] mt-3" style={{ color: "var(--text-3)" }}>
          For something in between, make a new role on the{" "}
          <Link href={orgPath("/admin")} className="underline underline-offset-2">
            Admin page
          </Link>
          , give it to them there, then mark this as done.
        </p>
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
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{runTitle(run)}</span>
        {kind === "approve" ? (
          <Pill tone="pending">Needs approval</Pill>
        ) : (
          <Pill tone="sync">Ready to run</Pill>
        )}
      </div>
      <div className="text-[13px] mt-0.5" style={{ color: "var(--text-2)" }}>
        {runTarget(run)}
      </div>
      {kind === "run" && run.decided_by && (
        <div className="text-[13px] mt-0.5" style={{ color: "var(--text-2)" }}>
          {`Approved by ${run.decided_by}.`}
          {run.expires_at ? ` Good until ${formatWhen(run.expires_at)}.` : ""}
        </div>
      )}
      <Meta>{`Asked for by ${run.requested_by}, ${formatWhen(run.requested_at)}.`}</Meta>
      {run.action === "revert" && (
        <div className="text-[13px] mt-1.5">
          On Deploy, use &quot;Roll back to&quot; on this target. The approval is waiting there.
        </div>
      )}
      {can("deploy:read") && (
        <div className="mt-3">
          <Link href={orgPath(deployHref(run))} className="btn btn-secondary btn-sm">
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

function NewMark({ decidedAt, since }: { decidedAt: string | null; since: string | null }) {
  if (!decidedAt) return null;
  if (since && new Date(decidedAt) <= new Date(since)) return null;
  return <Pill tone="brand">New</Pill>;
}

function OwnRequestRow({
  request,
  since,
  onChanged,
}: {
  request: AccessRequest;
  since: string | null;
  onChanged: () => void;
}) {
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
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{asked.title}</span>
        <Pill tone={pill.tone}>{pill.label}</Pill>
        <NewMark decidedAt={request.decided_at} since={since} />
      </div>
      {request.message && (
        <p className="text-[13px] mt-1.5 whitespace-pre-wrap break-words">{request.message}</p>
      )}
      {request.status === "allowed" && (
        <div className="text-[13px] mt-1.5">Reload the page you need it on, and you can use it.</div>
      )}
      {request.decision_note && (
        <div className="text-[13px] mt-1.5" style={{ color: "var(--text-2)" }}>
          {`Their note: ${request.decision_note}`}
        </div>
      )}
      <Meta>
        {`Asked ${formatWhen(request.created_at)}.`}
        {request.decided_by ? ` Answered by ${request.decided_by}, ${formatWhen(request.decided_at)}.` : ""}
      </Meta>
      {request.status === "pending" && (
        <div className="mt-3">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void withdraw()}>
            Withdraw
          </Button>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Card>
  );
}

function OwnRunRow({ run, since }: { run: ListedApproval; since: string | null }) {
  const { label, tone, story } = ownRunStory(run);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{runTitle(run)}</span>
        <Pill tone={tone}>{label}</Pill>
        {!run.self_approved && <NewMark decidedAt={run.decided_at} since={since} />}
      </div>
      <div className="text-[13px] mt-0.5" style={{ color: "var(--text-2)" }}>
        {runTarget(run)}
      </div>
      <div className="text-[13px] mt-1.5">{story}</div>
      {/* Not "their note": it stays the one you wrote unless the approver left another. */}
      {run.note && run.status !== "pending" && (
        <div className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
          {`Note: ${run.note}`}
        </div>
      )}
      <Meta>{`Asked ${formatWhen(run.requested_at)}.`}</Meta>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function RequestsBody() {
  const orgPath = useOrgHref();
  const { isAdmin } = useUser();
  const [data, setData] = useState<RequestsPayload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
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

  const nothingWaiting = inbox.length + toApprove.length + toRun.length === 0;
  // "Nothing is waiting" is for the person who answers requests. Anyone else came here to
  // ask for something, and an empty section would only push the form down the page.
  const showWaiting = data?.canAnswer || !nothingWaiting;
  const nothingOfYours = mine.length + myRuns.length === 0;

  return (
    <div className="max-w-[920px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
      <header>
        <div className="section-title">Requests</div>
        <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.02em] mt-1">
          {isAdmin ? "What people here need" : "Ask for what your role can't do"}
        </h1>
        <p className="text-[13.5px] mt-1.5 max-w-[60ch]" style={{ color: "var(--text-2)" }}>
          {isAdmin
            ? "Requests from your team and the production runs waiting on someone. "
            : "Ask here and read the answer here. "}
          The app does not send email, so a number beside Requests in the sidebar is how
          people find out.
        </p>
        <p className="text-[13.5px] mt-1.5" style={{ color: "var(--text-2)" }}>
          Away from a computer?{" "}
          <Link href={orgPath("/phone")} className="underline underline-offset-2">
            Open the phone app
          </Link>
          , which can alert you when something here needs you.
        </p>
      </header>

      {failed && <ErrorNote>{failed}</ErrorNote>}

      {!data && !failed && (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-[84px] rounded-xl" />
          <Skeleton className="h-[84px] rounded-xl" />
        </div>
      )}

      {data && showWaiting && (
        <section>
          <SectionHeading title="Waiting for you" />
          {nothingWaiting ? (
            <Card>
              <EmptyState
                icon={<InboxIcon size={18} />}
                title="Nothing is waiting for you"
                description="Requests and production runs that need you will show here."
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {inbox.map((request) => (
                <InboxRow key={request.id} request={request} onChanged={changed} />
              ))}
              {toApprove.map((run) => (
                <RunRow key={run.id} run={run} kind="approve" />
              ))}
              {toRun.map((run) => (
                <RunRow key={run.id} run={run} kind="run" />
              ))}
            </div>
          )}
        </section>
      )}

      {data && !isAdmin && <AskForm onSent={changed} />}

      {data && (!isAdmin || !nothingOfYours) && (
        <section>
          <SectionHeading title="Your requests" />
          {nothingOfYours ? (
            <p className="text-[13px]" style={{ color: "var(--text-2)" }}>
              You have not asked for anything here yet.
            </p>
          ) : (
            <div className="space-y-3">
              {mine.map((request) => (
                <OwnRequestRow key={request.id} request={request} since={since} onChanged={changed} />
              ))}
              {myRuns.map((run) => (
                <OwnRunRow key={run.id} run={run} since={since} />
              ))}
            </div>
          )}
        </section>
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
