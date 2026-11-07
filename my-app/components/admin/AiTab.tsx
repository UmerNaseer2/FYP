"use client";

import { useEffect, useState } from "react";
import { Card, ConfirmDialog, Skeleton } from "@/components/ui";
import { AlertCircleIcon, InfoIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import { isAiAdminView, type AiAdminView } from "@/lib/ai/views";
import type { AiFeature } from "@/lib/ai/prompts";

/**
 * The AI tab on the Admin screen (app/api/admin/ai/route.ts).
 *
 * AI starts off for every organization. Switching it on is what lets schema
 * structure leave this server for the AI service, so it asks first and says
 * exactly what is sent. Each feature can then be switched off on its own.
 * Who may use the features at all is the "Use AI assistance" permission on
 * the Roles & permissions tab (Editors and Admins out of the box).
 *
 * The usage card is the last 30 days from the ai_calls table: how many calls,
 * how many were answered from a saved answer, how many failed the app's
 * checks, tokens, and how long answers took.
 */

const SENT =
  "Table, column, index, constraint and view definitions, and the SQL of the scripts being reviewed. " +
  "Never rows of data, passwords, connection addresses or anyone's details.";

export function AiTab({ active }: { active: boolean }) {
  const [view, setView] = useState<AiAdminView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void (async () => {
      try {
        const response = await apiFetch("/api/admin/ai", { cache: "no-store" });
        const body = await jsonOf(response);
        if (!current) return;
        if (!response.ok || !isAiAdminView(body)) {
          setLoadError(errorFrom(body) ?? "Could not load the AI settings.");
          return;
        }
        setView(body);
        setLoadError(null);
      } catch {
        if (current) setLoadError("Network error while loading the AI settings.");
      }
    })();
    return () => {
      current = false;
    };
  }, [active]);

  async function save(change: { enabled?: boolean; features?: Partial<Record<AiFeature, boolean>> }) {
    setSaving(true);
    setActionError(null);
    try {
      const response = await apiFetch("/api/admin/ai", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const body = await jsonOf(response);
      if (!response.ok || !isAiAdminView(body)) {
        setActionError(errorFrom(body) ?? "Could not save the change.");
        return;
      }
      setView(body);
    } catch {
      setActionError("Network error while saving. Nothing was changed.");
    } finally {
      setSaving(false);
    }
  }

  if (loadError && !view) {
    return (
      <div className="role-note" role="alert">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">{"Couldn't load the AI settings"}</div>
          <div className="body">{loadError}</div>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton width="100%" height={120} radius={14} />
        <Skeleton width="100%" height={160} radius={14} />
      </div>
    );
  }

  const { setup } = view;
  const locked = !view.canUpdate || saving;

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="role-note" role="alert">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">{"Couldn't save"}</div>
            <div className="body">{actionError}</div>
          </div>
        </div>
      )}

      {!setup.configured && (
        <div className="role-note">
          <InfoIcon size={15} className="ico" />
          <div>
            <div className="title">No AI service is set up on this server</div>
            <div className="body">
              Whoever runs the server adds AI_BASE_URL, AI_API_KEY and the two model names to its settings and
              restarts it. Until then the switches below are saved but nothing is sent anywhere.
            </div>
          </div>
        </div>
      )}

      <Card className="p-4 sm:p-5">
        <h3 className="section-title">AI assistance</h3>
        <label className="mt-2 flex items-start gap-3 text-[13.5px]">
          <input
            type="checkbox"
            role="switch"
            className="mt-0.5"
            checked={view.enabled}
            disabled={locked}
            onChange={(event) => {
              if (event.target.checked) setConfirmOn(true);
              else void save({ enabled: false });
            }}
          />
          <span>
            <span className="font-medium">Let people in this organization use AI assistance</span>
            <span className="block mt-0.5" style={{ color: "var(--text-2)" }}>
              {view.enabled
                ? "On. Roles with Use AI assistance see the AI buttons on Compare, Deploy, Drift and the Script Editor."
                : "Off. Nothing about this organization's schemas is sent to an AI service."}
            </span>
          </span>
        </label>
        {setup.configured && setup.models && (
          <p className="text-[12.5px] mt-3" style={{ color: "var(--text-3)" }}>
            {`Service: ${setup.service}. Models: ${setup.models.smart} for reviews and explanations, ${setup.models.fast} for short summaries.`}
          </p>
        )}
        <p className="text-[12.5px] mt-1.5 max-w-[68ch]" style={{ color: "var(--text-3)" }}>
          {`What is sent: ${SENT} The app checks every answer against its own engine before showing it, and nothing the AI writes runs without someone approving it.`}
        </p>
      </Card>

      <Card className="p-4 sm:p-5">
        <h3 className="section-title">Features</h3>
        <ul className="mt-2 space-y-2">
          {view.features.map((feature) => (
            <li key={feature.key}>
              <label className="flex items-center gap-3 text-[13.5px]">
                <input
                  type="checkbox"
                  role="switch"
                  checked={view.enabled && feature.on}
                  disabled={locked || !view.enabled}
                  onChange={(event) => void save({ features: { [feature.key]: event.target.checked } })}
                />
                <span>{feature.label}</span>
              </label>
            </li>
          ))}
        </ul>
        {!view.enabled && (
          <p className="text-[12.5px] mt-2" style={{ color: "var(--text-3)" }}>
            Switch AI assistance on first.
          </p>
        )}
      </Card>

      <UsageCard view={view} />

      {view.updatedBy && view.updatedAt && (
        <p className="text-[12px]" style={{ color: "var(--text-3)" }}>
          {`Last changed by ${view.updatedBy}, ${new Date(view.updatedAt).toLocaleString()}.`}
        </p>
      )}

      <ConfirmDialog
        open={confirmOn}
        onClose={() => setConfirmOn(false)}
        onConfirm={() => void save({ enabled: true })}
        title="Switch AI assistance on?"
        description={`Schema structure from this organization's connections will be sent to ${setup.service ?? "the AI service"} when someone asks for AI help. ${SENT} Use test schemas only while the service is on a free plan.`}
        confirmLabel="Switch on"
      />
    </div>
  );
}

function UsageCard({ view }: { view: AiAdminView }) {
  const usage = view.usage;
  if (!usage) {
    return (
      <Card className="p-4 sm:p-5">
        <h3 className="section-title">Use</h3>
        <p className="text-[13px] mt-2" style={{ color: "var(--text-2)" }}>
          The use figures could not be read just now.
        </p>
      </Card>
    );
  }
  const used = usage.features.filter((f) => f.calls > 0);
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="section-title">{`Use in the last ${usage.days} days`}</h3>
        <span className="text-[12.5px]" style={{ color: "var(--text-3)" }}>
          {view.dailyLimit === null
            ? `${usage.today} calls today`
            : `${usage.today} of ${view.dailyLimit} calls today`}
        </span>
      </div>
      {used.length === 0 ? (
        <p className="text-[13px] mt-2" style={{ color: "var(--text-2)" }}>
          No AI calls yet.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="responsive-table w-full text-[12.5px]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr className="text-left" style={{ color: "var(--text-3)", borderBottom: "1px solid var(--border)" }}>
                {["Feature", "Calls", "Saved", "Failed", "Tokens in / out", "Median", "Slowest 5%", "Thumbs"].map(
                  (heading) => (
                    <th key={heading} className="font-medium px-3 py-2 uppercase tracking-wide text-[10.5px]">
                      {heading}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {used.map((f) => {
                const label = view.features.find((x) => x.key === f.feature)?.label ?? f.feature;
                return (
                  <tr key={f.feature} style={{ borderBottom: "1px solid var(--border)" }}>
                    <Td label="Feature">{label}</Td>
                    <Td label="Calls">{f.calls}</Td>
                    <Td label="Saved">{f.savedAnswers}</Td>
                    <Td label="Failed">{f.failed}</Td>
                    <Td label="Tokens in / out">{`${f.inputTokens.toLocaleString()} / ${f.outputTokens.toLocaleString()}`}</Td>
                    <Td label="Median">{seconds(f.medianMs)}</Td>
                    <Td label="Slowest 5%">{seconds(f.p95Ms)}</Td>
                    <Td label="Thumbs">{`${f.thumbsUp} up, ${f.thumbsDown} down`}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[12px] mt-2" style={{ color: "var(--text-3)" }}>
        Saved answers cost nothing: the same question about the same schema is answered from the last checked answer
        for seven days. Failed counts answers the app refused because they did not match its own checks.
      </p>
    </Card>
  );
}

function Td({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <td className="px-3 py-2 align-middle" data-label={label}>
      {children}
    </td>
  );
}

function seconds(ms: number | null): string {
  if (ms === null) return "none";
  return `${(ms / 1000).toFixed(1)} s`;
}
