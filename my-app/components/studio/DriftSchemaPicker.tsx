"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { ENVIRONMENT_META, type Environment } from "@/lib/environments";

type DriftStatus = "in_sync" | "drifted" | "unreachable";

/** One tracked schema as the picker needs it (a slice of TrackedSchemaListItem). */
export type DriftPickerItem = {
  id: number;
  schemaName: string;
  label: string | null;
  environment: Environment;
  connectionName: string | null;
  driftStatus: DriftStatus | null;
};

/** Last-known status as a short prefix, so the dropdown reads at a glance. */
function statusPrefix(status: DriftStatus | null): string {
  switch (status) {
    case "drifted":
      return "● drifted";
    case "unreachable":
      return "● unreachable";
    case "in_sync":
      return "● in sync";
    default:
      return "○ not checked";
  }
}

/**
 * The schema selector for the drift detail tab. A themed Select that
 * navigates to /drift?tab=detail&schema=<id> on change — the page is a server
 * component, so switching schema is just a new server render with fresh, live
 * drift data. The status prefix is the last *recorded* status (cheap metadata);
 * the page itself recomputes the live state on load.
 */
export function DriftSchemaPicker({
  items,
  selectedId,
}: {
  items: DriftPickerItem[];
  selectedId: number | null;
}) {
  const router = useRouter();

  return (
    <Select
      variant="input"
      mono
      ariaLabel="Select a tracked schema"
      style={{ maxWidth: 360 }}
      value={selectedId != null ? String(selectedId) : ""}
      placeholder="Select a tracked schema…"
      options={items.map((it) => {
        const source = it.label ?? it.connectionName ?? "no connection";
        // An <option> is plain text — no room for the coloured pill the rest of
        // the page uses — so the environment rides along as a word instead.
        const env = ENVIRONMENT_META[it.environment].label;
        return {
          value: String(it.id),
          label: `${statusPrefix(it.driftStatus)} · [${env}] ${it.schemaName} — ${source}`,
        };
      })}
      onChange={(id) => {
        if (id) router.push(`/drift?tab=detail&schema=${id}`);
      }}
    />
  );
}
