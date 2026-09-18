"use client";

import { useEffect, useState } from "react";
import { Card, Pill, Skeleton } from "@/components/ui";
import { AlertCircleIcon, CheckIcon } from "@/components/ui/icons";
import { useUser } from "@/hooks/useUser";
import { roleAtLeast } from "@/lib/auth-mode";
import {
  THRESHOLDS,
  THRESHOLD_KEYS,
  validateThreshold,
  type ThresholdDefinition,
  type ThresholdKey,
  type ThresholdSetting,
} from "@/lib/perf-thresholds";
import type { PerfTarget } from "./PerfTargetPicker";

/**
 * Spec feature 10 — "Allow custom alert thresholds for performance issues."
 *
 * A form over the five things this app can watch. Two decisions carried from
 * lib/perf-thresholds.ts, both visible on screen:
 *
 *   • Every rule starts switched off, with a suggested number already in the
 *     box. The suggestion is a starting point, not a claim about this database.
 *   • The rules are per connection-and-schema. "Slower than 200 ms is bad" is
 *     true of a login lookup and nonsense about a nightly report.
 *
 * The form validates with the same function the server validates with, so a
 * number the box accepts is a number the server will store. That is the whole
 * reason lib/perf-thresholds.ts has no database in it.
 */

/** Mirrors ThresholdsView in app/api/performance/thresholds/route.ts. */
type ThresholdsView = {
  connectionName: string;
  schema: string;
  settings: ThresholdSetting[];
  definitions: Record<ThresholdKey, ThresholdDefinition>;
};

/** What is in the boxes: a string per key, because an input holds text. */
type Draft = Record<ThresholdKey, { text: string; enabled: boolean }>;

type Loaded = { key: string; view: ThresholdsView | null; error: string | null };

export function AlertThresholds({ target }: { target: PerfTarget | null }) {
  const { role } = useUser();
  const mayEdit = roleAtLeast(role, "editor");

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const connectionId = target?.connectionId ?? "";
  const schema = target?.schema ?? "";
  const key = `${connectionId} ${schema}`;

  useEffect(() => {
    if (!connectionId || !schema) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/performance/thresholds?connectionId=${encodeURIComponent(connectionId)}` +
            `&schema=${encodeURIComponent(schema)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        const view = data as ThresholdsView;
        if (res.ok && Array.isArray(view?.settings) && view?.definitions) {
          setLoaded({ key, view, error: null });
          setDraft(toDraft(view));
        } else if (res.ok) {
          // An answer arrived, so blaming the network would send whoever reads
          // this looking in the wrong place. Without this the shape below threw
          // and landed in the catch, which says the server was never reached.
          setLoaded({
            key,
            view: null,
            error: "The server answered, but not with the alert thresholds.",
          });
        } else {
          setLoaded({
            key,
            view: null,
            error: data?.error ?? "Could not read the alert thresholds.",
          });
        }
        // A target change is a new form, so anything said about the last save
        // no longer applies to what is on screen.
        setSaved(false);
        setSaveError(null);
      } catch {
        if (cancelled) return;
        setLoaded({ key, view: null, error: "Could not reach the server." });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, key]);

  const current = loaded && loaded.key === key ? loaded : null;

  if (!connectionId || !schema) {
    return (
      <Card className="p-6 text-[13px]" style={{ color: "var(--text-3)" }}>
        Choose a PostgreSQL connection and a schema above to set what should
        raise an alert for it.
      </Card>
    );
  }

  const skeleton = (
    <Card className="p-4 space-y-3">
      <Skeleton width={220} height={16} />
      <Skeleton width="100%" height={60} />
      <Skeleton width="100%" height={60} />
    </Card>
  );

  // A read that failed has no draft to fill, so the skeleton cannot wait for
  // one. Waiting on the draft here left a failed read loading for ever and put
  // the message below out of reach on a first load, which is when a wrong
  // connection is most likely to be the reason it failed.
  if (current === null) return skeleton;

  const view = current.view;
  if (!view) {
    return (
      <div className="warn-inline">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">Could not read the alert thresholds</div>
          <div className="body">{current.error}</div>
        </div>
      </div>
    );
  }

  if (draft === null) return skeleton;

  /** Every problem the form can see, keyed so each row can show its own. */
  const problems = validateDraft(draft);
  const anyProblem = Object.keys(problems).length > 0;

  async function save() {
    if (!draft || anyProblem) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const res = await fetch("/api/performance/thresholds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId,
          schema,
          settings: THRESHOLD_KEYS.map((k) => ({
            key: k,
            value: Number(draft[k].text),
            enabled: draft[k].enabled,
          })),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const next = data as ThresholdsView;
        setLoaded({ key, view: next, error: null });
        // Re-seeded from what came back, not from what was sent, so the form
        // shows what is stored rather than what was hoped for.
        setDraft(toDraft(next));
        setSaved(true);
      } else {
        setSaveError(data?.error ?? "The thresholds could not be saved.");
      }
    } catch {
      setSaveError("Could not reach the server to save the thresholds.");
    } finally {
      setSaving(false);
    }
  }

  const enabledCount = THRESHOLD_KEYS.filter((k) => draft[k].enabled).length;

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone={enabledCount > 0 ? "brand" : "neutral"}>
            {enabledCount === 0 ? "None switched on" : `${enabledCount} switched on`}
          </Pill>
          <span className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
            for <span className="mono">{view.schema}</span> on {view.connectionName}
          </span>
        </div>
        <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          These rules apply to this connection and this schema only, and every one
          of them starts switched off. The numbers already in the boxes are
          suggestions — this app has not looked at your database and decided what
          is slow. A rule that is off is never checked and never fires.
        </div>
      </Card>

      <div className="space-y-2.5">
        {THRESHOLD_KEYS.map((k) => (
          <ThresholdRow
            key={k}
            definition={view.definitions[k]}
            value={draft[k]}
            problem={problems[k] ?? null}
            disabled={!mayEdit}
            onChange={(next) => {
              setDraft({ ...draft, [k]: next });
              setSaved(false);
            }}
          />
        ))}
      </div>

      {!mayEdit && (
        <div className="warn-inline">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="body">
              You can see these rules but not change them. Changing what the app
              alerts on changes it for everybody using this connection, so it
              needs the editor role.
            </div>
          </div>
        </div>
      )}

      {saveError && (
        <div className="banner">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">The thresholds were not saved</div>
            <div className="body">{saveError}</div>
          </div>
        </div>
      )}

      {mayEdit && (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving || anyProblem}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save thresholds"}
          </button>
          {anyProblem && (
            <span className="text-[12px]" style={{ color: "var(--break)" }}>
              Fix the numbers above first.
            </span>
          )}
          {saved && !anyProblem && (
            <span
              className="text-[12px] flex items-center gap-1"
              style={{ color: "var(--sync, var(--text-2))" }}
            >
              <CheckIcon size={13} /> Saved.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ThresholdRow({
  definition,
  value,
  problem,
  disabled,
  onChange,
}: {
  definition: ThresholdDefinition;
  value: { text: string; enabled: boolean };
  problem: string | null;
  disabled: boolean;
  onChange: (next: { text: string; enabled: boolean }) => void;
}) {
  const inputId = `threshold-${definition.key}`;
  return (
    <Card className="p-3.5 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          {definition.label}
        </label>

        <div className="flex items-center gap-1.5 ml-auto">
          <label htmlFor={inputId} className="sr-only">
            {definition.label}
          </label>
          <input
            id={inputId}
            type="number"
            className="input"
            style={{ width: 120 }}
            // The stored unit and the shown unit differ for a ratio: 0.9 is
            // stored, 90 is shown. Doing that in the box rather than in the
            // store keeps one definition of the range on both sides.
            value={definition.asPercent ? percentText(value.text) : value.text}
            step={definition.asPercent ? 1 : "any"}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                text: definition.asPercent ? ratioText(e.target.value) : e.target.value,
              })
            }
          />
          <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
            {definition.unit}
          </span>
        </div>
      </div>

      <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
        {definition.help}
        {!value.enabled && " This rule is off, so it is never checked."}
      </div>

      {problem && (
        <div className="text-[12px]" style={{ color: "var(--break)" }}>
          {problem}
        </div>
      )}
    </Card>
  );
}

/** Stored settings into the strings the boxes hold. */
function toDraft(view: ThresholdsView): Draft {
  const draft = {} as Draft;
  for (const setting of view.settings) {
    draft[setting.key] = { text: String(setting.value), enabled: setting.enabled };
  }
  // Any key the server did not send still needs a box, or typing in it would
  // read from undefined. getThresholds returns every key, so this is only a
  // guard against a response from a different version.
  for (const k of THRESHOLD_KEYS) {
    if (!draft[k]) draft[k] = { text: String(view.definitions[k].suggested), enabled: false };
  }
  return draft;
}

/**
 * Check the whole form with the server's own validator.
 *
 * A rule that is switched off is still checked, because it is still about to be
 * stored: saving a disabled rule with an impossible number would mean switching
 * it on later silently does nothing.
 */
function validateDraft(draft: Draft): Partial<Record<ThresholdKey, string>> {
  const problems: Partial<Record<ThresholdKey, string>> = {};
  for (const k of THRESHOLD_KEYS) {
    // An empty box is not a zero. Number("") is 0, and three of these rules
    // take 0 as their minimum, so without this a cleared box saved quietly as
    // 0 — a score rule that can never fire, or a dead-row rule that fires on
    // everything. Checking the text before it is turned into a number is the
    // only place the difference between "0" and "" still exists.
    if (draft[k].text.trim() === "") {
      problems[k] = `${THRESHOLDS[k].label} needs a number.`;
      continue;
    }
    const problem = validateThreshold(k, Number(draft[k].text));
    if (problem) problems[k] = problem;
  }
  return problems;
}

/** 0.9 → "90". An unparseable box is left alone so typing is not fought. */
function percentText(stored: string): string {
  if (stored.trim() === "") return stored;
  const n = Number(stored);
  return Number.isFinite(n) ? String(Math.round(n * 100)) : stored;
}

/** "90" → "0.9", the reverse of the above. An emptied box stays empty rather
 *  than becoming "0", which would be a number nobody typed. */
function ratioText(shown: string): string {
  if (shown.trim() === "") return shown;
  const n = Number(shown);
  return Number.isFinite(n) ? String(n / 100) : shown;
}
