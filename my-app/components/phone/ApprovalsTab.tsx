"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, Input, Pill } from "@/components/ui";
import { InboxIcon } from "@/components/ui/icons";
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
import { HIDDEN_SQL_TEXT, hasHiddenCharacters, showHiddenCharacters } from "@/lib/hidden-characters";
import type { ApprovalScript, ListedApproval } from "@/lib/approvals-db";
import {
  STATUS_PILLS,
  deployHref,
  describeAsked,
  formatWhen,
  ownRunStory,
  runTarget,
  runTitle,
} from "@/lib/request-wording";
import {
  ErrorNote,
  Meta,
  RefreshRow,
  RowsLoading,
  SectionHeading,
  errorFrom,
  sendJson,
  useJson,
} from "./parts";

/** Tell the waiting count in the tab bar that something changed. */
function announceChange() {
  window.dispatchEvent(new Event(REQUESTS_CHANGED_EVENT));
}

function NoteStep({
  confirmLabel,
  destructive,
  busy,
  note,
  onNote,
  onConfirm,
  onCancel,
}: {
  confirmLabel: string;
  destructive?: boolean;
  busy: boolean;
  note: string;
  onNote: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-3">
      <label className="block text-[13px]" style={{ color: "var(--text-2)" }}>
        Note (optional)
        <Input
          className="mt-1 w-full"
          value={note}
          maxLength={REQUEST_TEXT_MAX}
          onChange={(event) => onNote(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2 mt-2">
        <Button
          size="sm"
          variant={destructive ? "destructive" : "primary"}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

type SqlCopy =
  | { kind: "kept"; scripts: ApprovalScript[] }
  | { kind: "none"; message: string };

const NO_COPY =
  "No copy of this SQL was kept with the request. Read it on the Deploy page of the full site before you approve it.";

function SqlBlock({ copy }: { copy: SqlCopy }) {
  if (copy.kind === "none") {
    return (
      <div className="mt-3">
        <ErrorNote>{copy.message}</ErrorNote>
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-2">
      {copy.scripts.map((script) => (
        <div key={`${script.scriptName}-${script.version}`}>
          <div className="text-[12px] font-semibold" style={{ color: "var(--text-2)" }}>
            {`${script.scriptName}, v${script.version}`}
          </div>
          <pre
            className="text-[12px] mt-1 p-2 rounded-lg overflow-auto"
            style={{ background: "var(--surface-3)", maxHeight: 320 }}
          >
            {/* Characters that do not show on screen are marked, so the
                SQL read here is the SQL that runs. */}
            {showHiddenCharacters(script.sqlContent)}
          </pre>
        </div>
      ))}
    </div>
  );
}

/**
 * A production run waiting for a yes or a no. Approving is the same call the
 * Deploy page makes, with the fingerprint this card was drawn from, so a yes
 * cannot land on a run that changed after it was read. The SQL opens as soon as
 * someone reaches for Approve, because nobody should approve SQL they cannot see.
 */
function RunToApprove({ run, onChanged }: { run: ListedApproval; onChanged: () => void }) {
  const [step, setStep] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copy, setCopy] = useState<SqlCopy | null>(null);
  // SQL with characters that do not show on screen may look like something
  // other than what it runs, so it may be rejected here but not approved.
  const hidden =
    copy?.kind === "kept" && copy.scripts.some((script) => hasHiddenCharacters(script.sqlContent));

  async function readSql() {
    if (copy) return;
    setBusy(true);
    try {
      const response = await apiFetch(`/api/deploy/approvals/${run.id}/phone`);
      if (!response.ok) {
        setCopy({ kind: "none", message: await errorFrom(response, NO_COPY) });
        return;
      }
      const body = (await response.json()) as {
        fingerprint: string;
        scripts: ApprovalScript[] | null;
      };
      if (body.fingerprint !== run.run_fingerprint) {
        setCopy({ kind: "none", message: "This request has changed. Refresh and read it again." });
      } else if (body.scripts === null) {
        setCopy({ kind: "none", message: NO_COPY });
      } else {
        setCopy({ kind: "kept", scripts: body.scripts });
      }
    } catch {
      setCopy({ kind: "none", message: NO_COPY });
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const done = await sendJson(
      `/api/deploy/approvals/${run.id}`,
      "POST",
      { decision, note: note.trim(), expectedFingerprint: run.run_fingerprint },
      "Could not record that decision.",
      setError
    );
    setBusy(false);
    if (done) {
      announceChange();
      onChanged();
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{runTitle(run)}</span>
        <Pill tone="pending">Needs approval</Pill>
        {run.breaking_count > 0 && <Pill tone="break">{`${run.breaking_count} breaking`}</Pill>}
      </div>
      <div className="text-[13px] mt-0.5" style={{ color: "var(--text-2)" }}>
        {runTarget(run)}
      </div>
      <Meta>{`Asked for by ${run.requested_by}, ${formatWhen(run.requested_at)}.`}</Meta>

      {copy && <SqlBlock copy={copy} />}
      {hidden && (
        <div className="mt-2">
          <ErrorNote>{HIDDEN_SQL_TEXT}</ErrorNote>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {step === null || (step === "approve" && hidden) ? (
        <div className="flex flex-wrap gap-2 mt-3">
          {!copy && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void readSql()}>
              Read SQL
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy || hidden}
            onClick={() => {
              setStep("approve");
              void readSql();
            }}
          >
            Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStep("reject")}>
            Reject
          </Button>
        </div>
      ) : (
        <NoteStep
          confirmLabel={step === "approve" ? "Approve this run" : "Reject this run"}
          destructive={step === "reject"}
          busy={busy}
          note={note}
          onNote={setNote}
          onConfirm={() => void decide(step)}
          onCancel={() => setStep(null)}
        />
      )}
    </Card>
  );
}

/**
 * Someone asking for access. Allowing it changes a role, and choosing which one
 * takes the full Requests page. Declining or marking it done are only an answer.
 */
function AccessRequestCard({
  request,
  onChanged,
}: {
  request: InboxRequest;
  onChanged: () => void;
}) {
  const orgPath = useOrgHref();
  const [step, setStep] = useState<RequestAnswer | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = describeAsked(request.permission);

  async function answer(value: RequestAnswer) {
    setBusy(true);
    setError(null);
    const done = await sendJson(
      `/api/requests/${request.id}`,
      "PATCH",
      { action: "answer", answer: value, note: note.trim() },
      "Could not record that answer.",
      setError
    );
    setBusy(false);
    if (done) {
      announceChange();
      onChanged();
    }
  }

  return (
    <Card className="p-4">
      <div className="text-[13.5px] font-semibold">{asked.title}</div>
      <div className="text-[13px] mt-0.5" style={{ color: "var(--text-2)" }}>
        {`${request.requested_by_name ?? request.requested_by} asked. Their role is ${request.member_role_label}.`}
      </div>
      {request.message && <div className="text-[13px] mt-1.5">{request.message}</div>}
      <Meta>{formatWhen(request.created_at)}</Meta>
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {step === null ? (
        <div className="flex flex-wrap gap-2 mt-3">
          <Link href={orgPath("/requests")} className="btn btn-secondary btn-sm">
            Allow on the full site
          </Link>
          <Button size="sm" variant="ghost" onClick={() => setStep("done")}>
            Mark done
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setStep("declined")}>
            Decline
          </Button>
        </div>
      ) : (
        <NoteStep
          confirmLabel={step === "declined" ? "Decline this request" : "Mark this done"}
          destructive={step === "declined"}
          busy={busy}
          note={note}
          onNote={setNote}
          onConfirm={() => void answer(step)}
          onCancel={() => setStep(null)}
        />
      )}
    </Card>
  );
}

function RunToRun({ run }: { run: ListedApproval }) {
  const { can } = useUser();
  const orgPath = useOrgHref();
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{runTitle(run)}</span>
        <Pill tone="sync">Ready to run</Pill>
      </div>
      <div className="text-[13px] mt-0.5" style={{ color: "var(--text-2)" }}>
        {runTarget(run)}
      </div>
      {run.decided_by && <Meta>{`Approved by ${run.decided_by}.`}</Meta>}
      {can("deploy:read") && (
        <div className="mt-3">
          <Link href={orgPath(deployHref(run))} className="btn btn-secondary btn-sm">
            Open it on Deploy
          </Link>
        </div>
      )}
    </Card>
  );
}

function OwnRun({ run }: { run: ListedApproval }) {
  const story = ownRunStory(run);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{runTitle(run)}</span>
        <Pill tone={story.tone}>{story.label}</Pill>
      </div>
      <div className="text-[13px] mt-0.5" style={{ color: "var(--text-2)" }}>
        {story.story}
      </div>
      <Meta>{runTarget(run)}</Meta>
    </Card>
  );
}

function OwnRequest({ request }: { request: AccessRequest }) {
  const asked = describeAsked(request.permission);
  const pill = STATUS_PILLS[request.status];
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{asked.title}</span>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>
      {request.decision_note && (
        <div className="text-[13px] mt-1">{request.decision_note}</div>
      )}
      <Meta>{formatWhen(request.decided_at ?? request.created_at)}</Meta>
    </Card>
  );
}

export default function ApprovalsTab() {
  const orgPath = useOrgHref();
  const requests = useJson<RequestsPayload>("/api/requests", "Could not read your requests.");
  const data = requests.data;

  useEffect(() => {
    if (!data) return;
    // A fresh read, so the number on the tab should agree with the list under it.
    // The answers are on screen now too, so they stop counting as unread, the same
    // as on the Requests page. A number that never went down would get ignored.
    if (data.counts.answered > 0) {
      apiFetch("/api/requests/seen", { method: "POST" })
        .catch(() => undefined)
        .finally(announceChange);
    } else {
      announceChange();
    }
  }, [data]);

  if (requests.loading) return <RowsLoading />;

  const onChanged = () => void requests.reload();
  const waitingOnYou = data
    ? data.runsToApprove.length + data.inbox.length + data.runsToRun.length
    : 0;
  const yours = data ? data.mine.length + data.myRuns.length : 0;

  return (
    <div>
      <RefreshRow onRefresh={requests.reload} />
      {requests.error && <ErrorNote>{requests.error}</ErrorNote>}
      {data && waitingOnYou + yours === 0 && (
        <EmptyState
          icon={<InboxIcon className="ico" />}
          title="Nothing waiting"
          description="Runs to approve and requests for access show up here."
        />
      )}
      {data && data.runsToApprove.length > 0 && (
        <>
          <SectionHeading>Runs to approve</SectionHeading>
          <div className="flex flex-col gap-2">
            {data.runsToApprove.map((run) => (
              // Keyed by the fingerprint too. The list reads again by itself, and a
              // decision sends the fingerprint on this row, so SQL read for an older
              // version must not stay on screen above it.
              <RunToApprove key={`${run.id}:${run.run_fingerprint}`} run={run} onChanged={onChanged} />
            ))}
          </div>
        </>
      )}
      {data && data.inbox.length > 0 && (
        <>
          <SectionHeading>Requests for access</SectionHeading>
          <div className="flex flex-col gap-2">
            {data.inbox.map((request) => (
              <AccessRequestCard key={request.id} request={request} onChanged={onChanged} />
            ))}
          </div>
        </>
      )}
      {data && data.runsToRun.length > 0 && (
        <>
          <SectionHeading>Approved and ready to run</SectionHeading>
          <div className="flex flex-col gap-2">
            {data.runsToRun.map((run) => (
              <RunToRun key={run.id} run={run} />
            ))}
          </div>
        </>
      )}
      {data && yours > 0 && (
        <>
          <SectionHeading>Yours</SectionHeading>
          <div className="flex flex-col gap-2">
            {data.myRuns.map((run) => (
              <OwnRun key={run.id} run={run} />
            ))}
            {data.mine.map((request) => (
              <OwnRequest key={request.id} request={request} />
            ))}
          </div>
        </>
      )}
      <div className="mt-4 text-[13px]">
        <Link href={orgPath("/requests")} style={{ color: "var(--brand)" }}>
          Ask for something on the full site
        </Link>
      </div>
    </div>
  );
}
