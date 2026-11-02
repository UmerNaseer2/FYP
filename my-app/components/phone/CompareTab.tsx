"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button, Card, EnvironmentPill, Pill } from "@/components/ui";
import { Select, type SelectOption } from "@/components/ui/Select";
import { TIMED_OUT, type Computer, type JobAnswer } from "@/lib/agent-rules";
import { apiFetch } from "@/lib/api-fetch";
import { ENVIRONMENT_META, type Environment } from "@/lib/environments";
import type {
  ChangeLine,
  CompareSummary,
  PhoneCompareRequest,
  TargetSummary,
} from "@/lib/phone-compare";
import { timeAgo } from "@/lib/time-ago";
import {
  ErrorNote,
  JSON_HEADERS,
  Meta,
  OFFLINE_TEXT,
  RefreshRow,
  RowsLoading,
  errorFrom,
  sendJson,
  useJson,
} from "./parts";

const SITE = "site";

const POLL_MS = 1500;

/** The site reads a question as failed after 180 seconds, so this only backs that up. */
const GIVE_UP_MS = 200_000;

const NO_SCHEMAS = "Could not read the schemas on that connection.";
const NOT_COMPARED = "Could not compare those schemas.";

const CHANGE_LABELS: Record<ChangeLine["change"], string> = {
  added: "Added",
  dropped: "Dropped",
  changed: "Changed",
  renamed: "Renamed",
  "rename-suggested": "Possible rename",
};

const SEVERITIES: Record<ChangeLine["severity"], { label: string; tone: "break" | "sync" | "neutral" }> = {
  breaking: { label: "Breaking", tone: "break" },
  safe: { label: "Safe", tone: "sync" },
  info: { label: "Info", tone: "neutral" },
};

type SavedConnection = { id: number; name: string; environment: Environment };

type Asked<T> = { ok: true; result: T } | { ok: false; error: string };

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countText(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Leaves a question for a computer and waits for its answer. The computer asks
 * the site for work, because nothing can reach it directly, so an answer can
 * take a while. Gives null once nobody is waiting any more.
 */
async function askComputer<T>(
  computerId: number,
  method: string,
  params: unknown,
  fallback: string,
  stillWanted: () => boolean
): Promise<Asked<T> | null> {
  let id: number;
  try {
    const response = await apiFetch("/api/computers/jobs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ computerId, method, params }),
    });
    if (!response.ok) return { ok: false, error: await errorFrom(response, fallback) };
    id = ((await response.json()) as { id: number }).id;
  } catch {
    return { ok: false, error: OFFLINE_TEXT };
  }

  const giveUpAt = Date.now() + GIVE_UP_MS;
  let offline = false;
  while (stillWanted()) {
    if (Date.now() >= giveUpAt) return { ok: false, error: offline ? OFFLINE_TEXT : TIMED_OUT };
    try {
      const response = await apiFetch(`/api/computers/jobs/${id}`);
      offline = false;
      if (response.ok) {
        const answer = (await response.json()) as JobAnswer;
        if (answer.status === "done") return { ok: true, result: answer.result as T };
        if (answer.status === "failed") return { ok: false, error: answer.error };
      } else if (response.status < 500) {
        return { ok: false, error: await errorFrom(response, fallback) };
      }
      // A failure of the site's own, or a lost signal, may be over by the next try.
    } catch {
      offline = true;
    }
    await wait(POLL_MS);
  }
  return null;
}

async function readSchemas(
  place: string,
  connectionId: number,
  stillWanted: () => boolean
): Promise<Asked<{ schemas: string[] }> | null> {
  if (place !== SITE) {
    return askComputer(Number(place), "schemas.list", { connectionId }, NO_SCHEMAS, stillWanted);
  }
  try {
    const response = await apiFetch(`/api/lineage/schemas?connectionId=${connectionId}`);
    if (!response.ok) return { ok: false, error: await errorFrom(response, NO_SCHEMAS) };
    return { ok: true, result: (await response.json()) as { schemas: string[] } };
  } catch {
    return { ok: false, error: OFFLINE_TEXT };
  }
}

async function compareOnSite(request: PhoneCompareRequest): Promise<Asked<CompareSummary>> {
  try {
    const response = await apiFetch("/api/compare/phone", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    });
    if (!response.ok) return { ok: false, error: await errorFrom(response, NOT_COMPARED) };
    return { ok: true, result: (await response.json()) as CompareSummary };
  } catch {
    return { ok: false, error: OFFLINE_TEXT };
  }
}

/** The schemas on one connection, kept with what they were read for so an old list never shows. */
function useSchemaList(place: string, connectionId: string) {
  const [tries, setTries] = useState(0);
  const [read, setRead] = useState<{ key: string; answer: Asked<{ schemas: string[] }> } | null>(null);
  const key = `${place}/${connectionId}/${tries}`;

  useEffect(() => {
    if (connectionId === "") return;
    let current = true;
    void readSchemas(place, Number(connectionId), () => current).then((answer) => {
      if (current && answer !== null) setRead({ key, answer });
    });
    return () => {
      current = false;
    };
  }, [key, place, connectionId]);

  const answer = read?.key === key ? read.answer : null;
  return {
    schemas: answer?.ok ? answer.result.schemas : [],
    error: answer !== null && !answer.ok ? answer.error : null,
    loading: connectionId !== "" && answer === null,
    retry: () => setTries((count) => count + 1),
  };
}

function Field({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="section-title" htmlFor={id}>
        {label}
      </label>
      <Select
        id={id}
        ariaLabel={label}
        variant="input"
        value={value}
        options={options}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  );
}

function SidePicker({
  side,
  place,
  connections,
  connectionId,
  schema,
  onConnection,
  onSchema,
}: {
  side: "Source" | "Target";
  place: string;
  connections: SavedConnection[];
  connectionId: string;
  schema: string;
  onConnection: (value: string) => void;
  onSchema: (value: string) => void;
}) {
  const { schemas, error, loading, retry } = useSchemaList(place, connectionId);
  const connectionOptions = connections.map((entry) => ({
    value: String(entry.id),
    label:
      entry.environment === "unset"
        ? entry.name
        : `${entry.name}, ${ENVIRONMENT_META[entry.environment].label}`,
  }));
  const schemaOptions = schemas.map((name) => ({ value: name, label: name }));

  return (
    <>
      <Field
        label={`${side} connection`}
        value={connectionId}
        options={connectionOptions}
        onChange={onConnection}
        placeholder="Choose a connection"
      />
      <Field
        label={`${side} schema`}
        value={schema}
        options={schemaOptions}
        onChange={onSchema}
        placeholder={loading ? "Reading the schemas…" : "Choose a schema"}
        disabled={connectionId === "" || loading || error !== null}
      />
      {error !== null && (
        <div className="flex flex-col gap-2 items-start">
          <ErrorNote>{error}</ErrorNote>
          <Button size="sm" variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
    </>
  );
}

function headline(target: TargetSummary): string {
  switch (target.status) {
    case "compared":
      return target.changes === 0
        ? "No differences"
        : countText(target.changes, "difference", "differences");
    case "same-as-source":
      return "Same as the source";
    case "unreachable":
      return "Could not connect";
    case "schema-missing":
      return "No such schema";
    case "duplicate":
      return "Compared already";
    case "no-connection":
      return "Connection not found";
    case "failed":
      return "Could not compare";
  }
}

function TargetResult({ target, seeAll }: { target: TargetSummary; seeAll: string }) {
  const second = { color: "var(--text-2)" };
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-[14px] font-semibold">{target.name}</h3>
        <EnvironmentPill environment={target.environment} />
      </div>
      <Meta>{target.schema}</Meta>
      <p className="text-[14px] font-medium mt-2">{headline(target)}</p>
      {target.error !== null && (
        <p className="text-[13px] mt-1" style={second}>
          {target.error}
        </p>
      )}
      {target.breaking + target.manual > 0 && (
        <p className="text-[13px] mt-1" style={second}>
          {countText(target.breaking, "breaking change", "breaking changes")},{" "}
          {countText(target.manual, "to finish by hand", "to finish by hand")}
        </p>
      )}
      {target.lines.length > 0 && (
        <ul className="flex flex-col gap-2 mt-3">
          {target.lines.map((line, index) => (
            <li key={index} className="text-[13px]">
              <div>
                <strong>{CHANGE_LABELS[line.change]}</strong> {line.category}{" "}
                <span className="mono">
                  {line.table === "" ? line.object : `${line.table}.${line.object}`}
                </span>
              </div>
              {line.detail !== "" && (
                <div className="mt-0.5" style={second}>
                  {line.detail}
                </div>
              )}
              <div className="flex gap-1 flex-wrap mt-1">
                <Pill tone={SEVERITIES[line.severity].tone}>{SEVERITIES[line.severity].label}</Pill>
                {line.manual && <Pill tone="neutral">Finish by hand</Pill>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {target.moreLines > 0 && (
        <Meta>
          And {countText(target.moreLines, "more change", "more changes")}. {seeAll}
        </Meta>
      )}
      {target.history !== null && <Meta>{target.history}</Meta>}
    </Card>
  );
}

/** A lost or sold computer can be cut off from here, without going near it. */
function UnlinkComputer({ computer, onGone }: { computer: Computer; onGone: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink() {
    setBusy(true);
    setError(null);
    const done = await sendJson(
      `/api/computers/${computer.id}`,
      "DELETE",
      {},
      "Could not unlink that computer.",
      setError
    );
    setBusy(false);
    if (done) await onGone();
  }

  if (!asking) {
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
          Unlink this computer
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px]" style={{ color: "var(--text-2)" }}>
        Unlink {computer.name}? It stops answering questions here until it is linked again.
      </div>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void unlink()}>
          {busy ? "Unlinking…" : "Unlink"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
          Keep it linked
        </Button>
      </div>
    </div>
  );
}

/**
 * Compares two schemas from a phone, in one of two places: on the connections
 * saved on this site, or on a computer linked to this person's account, whose
 * database passwords stay on it. The two sides are always in the same place,
 * because a computer's answer knows nothing of the site's connections.
 */
export default function CompareTab() {
  const computers = useJson<{ computers: Computer[] }>("/api/computers", "Could not list your computers.");
  const site = useJson<{ connections: SavedConnection[] }>(
    "/api/connections/phone",
    "Could not read this site's saved connections."
  );

  const [picked, setPicked] = useState(SITE);
  const [sourceId, setSourceId] = useState("");
  const [sourceSchema, setSourceSchema] = useState("");
  const [targetId, setTargetId] = useState("");
  const [targetSchema, setTargetSchema] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<CompareSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the newest question may answer. Anything older is about a choice since changed.
  const latest = useRef(0);

  useEffect(
    () => () => {
      latest.current += 1;
    },
    []
  );

  const linked = computers.data?.computers ?? [];
  const computer = linked.find((entry) => String(entry.id) === picked);
  // A computer unlinked since it was chosen is no longer a place to compare.
  const place = computer === undefined ? SITE : picked;
  const connections = computer?.connections ?? site.data?.connections ?? [];
  // Ids mean nothing across places, so a pick made on that computer is not one here.
  const has = (id: string) => picked === place && connections.some((entry) => String(entry.id) === id);
  const source = has(sourceId) ? sourceId : "";
  const target = has(targetId) ? targetId : "";
  const sourceName = source === "" ? "" : sourceSchema;
  const targetName = target === "" ? "" : targetSchema;

  function forgetAnswer() {
    latest.current += 1;
    setBusy(false);
    setSummary(null);
    setError(null);
  }

  function choosePlace(value: string) {
    forgetAnswer();
    setPicked(value);
    setSourceId("");
    setSourceSchema("");
    setTargetId("");
    setTargetSchema("");
  }

  function chooseSource(value: string) {
    forgetAnswer();
    setSourceId(value);
    setSourceSchema("");
  }

  function chooseTarget(value: string) {
    forgetAnswer();
    setTargetId(value);
    setTargetSchema("");
  }

  async function compare() {
    forgetAnswer();
    const mine = latest.current;
    setBusy(true);
    const request: PhoneCompareRequest = {
      source: { connectionId: Number(source), schema: sourceName },
      targets: [{ connectionId: Number(target), schema: targetName }],
    };
    const asked =
      place === SITE
        ? await compareOnSite(request)
        : await askComputer<CompareSummary>(
            Number(place),
            "compare.run",
            request,
            NOT_COMPARED,
            () => mine === latest.current
          );
    if (mine !== latest.current || asked === null) return;
    setBusy(false);
    if (asked.ok) setSummary(asked.result);
    else setError(asked.error);
  }

  if (computers.loading || site.loading) return <RowsLoading />;

  const placeOptions = [
    { value: SITE, label: "This site's connections" },
    ...linked.map((entry) => ({
      value: String(entry.id),
      label: entry.online ? entry.name : `${entry.name} (off or asleep)`,
    })),
  ];
  const ready = sourceName !== "" && targetName !== "";
  const seeAll =
    computer === undefined
      ? "See them all on the full site's Compare page."
      : "See them all in Schema Studio on the computer.";

  return (
    <div className="flex flex-col gap-3">
      <RefreshRow
        onRefresh={async () => {
          await Promise.all([computers.reload(), site.reload()]);
        }}
      />
      {computers.error !== null && <ErrorNote>{computers.error}</ErrorNote>}
      {site.error !== null && <ErrorNote>{site.error}</ErrorNote>}

      <Card className="p-4 flex flex-col gap-3">
        <Field label="Compare on" value={place} options={placeOptions} onChange={choosePlace} />
        {linked.length === 0 && computers.error === null && (
          <Meta>
            To compare databases on your own computer, open Schema Studio there, go to Settings and link
            it under Web site.
          </Meta>
        )}
        {computer !== undefined && !computer.online && (
          <Meta>
            {computer.name} is off or asleep.{" "}
            {computer.lastSeenAt === null
              ? "It has not checked in yet."
              : `It last checked in ${timeAgo(computer.lastSeenAt)}.`}
          </Meta>
        )}
        {computer !== undefined && connections.length === 0 && (
          <Meta>
            Nothing is shared from this computer yet. Share connections in Schema Studio&apos;s Settings
            on the computer.
          </Meta>
        )}
        {computer === undefined && connections.length === 0 && site.error === null && (
          <Meta>This site has no saved connections yet.</Meta>
        )}

        <SidePicker
          side="Source"
          place={place}
          connections={connections}
          connectionId={source}
          schema={sourceName}
          onConnection={chooseSource}
          onSchema={(value) => {
            forgetAnswer();
            setSourceSchema(value);
          }}
        />
        <SidePicker
          side="Target"
          place={place}
          connections={connections}
          connectionId={target}
          schema={targetName}
          onConnection={chooseTarget}
          onSchema={(value) => {
            forgetAnswer();
            setTargetSchema(value);
          }}
        />

        <div>
          <Button disabled={!ready || busy} onClick={() => void compare()}>
            {busy ? "Comparing…" : "Compare"}
          </Button>
        </div>
        {busy && computer !== undefined && (
          <div role="status" className="text-[13px]" style={{ color: "var(--text-2)" }}>
            Asking {computer.name}. It looks for new questions every 15 seconds, so this can take a
            moment.
          </div>
        )}
        {computer !== undefined && (
          <Meta>
            Questions and answers pass through this site. An answer holds connection and schema names and
            a summary of the changes, never SQL, hosts, database names or rows.
          </Meta>
        )}
        {computer !== undefined && (
          <UnlinkComputer
            key={computer.id}
            computer={computer}
            onGone={async () => {
              choosePlace(SITE);
              await computers.reload();
            }}
          />
        )}
      </Card>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {summary !== null && (
        <>
          {summary.source.error !== null && <ErrorNote>{summary.source.error}</ErrorNote>}
          <Meta>
            Compared with {summary.source.name}, {summary.source.schema}
          </Meta>
          {summary.targets.map((entry, index) => (
            <TargetResult key={index} target={entry} seeAll={seeAll} />
          ))}
        </>
      )}
    </div>
  );
}
