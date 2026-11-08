// ---------------------------------------------------------------------------
// lib/ai/dependents.ts
// "What uses this object?", from what a snapshot already holds.
//
// Three kinds of link are known for sure:
//   - a view reads a table or another view (ViewSnapshot.dependsOn, from pg_depend)
//   - a table's foreign key points at another table (referencedTable)
//   - a trigger on a table calls a function (TriggerSnapshot.functionName)
//
// Routines (functions and procedures) have no dependency data in a snapshot,
// so whatever they read is unknown. The AI is told "unknown" for them and
// never a guess. Only objects in the snapshot's own schema are linked: a
// foreign key to another schema is noted with that schema's name.
// ---------------------------------------------------------------------------

import type { SchemaSnapshot } from "../postgres";

export type Dependent = {
  /** What depends on the object. */
  kind: "view" | "materialized view" | "table (foreign key)" | "trigger";
  name: string;
  /** How: "reads it", "fk orders_customer_id_fkey (customer_id)". */
  via: string;
};

export type DependencyIndex = {
  /** Everything that uses the named table or view, sorted by kind then name. */
  dependentsOf(name: string): Dependent[];
  /** The tables a table's foreign keys point at, in this schema. */
  referencesOf(table: string): string[];
  /** Functions called by a table's triggers. */
  triggerFunctionsOf(table: string): string[];
};

export function buildDependencyIndex(snapshot: SchemaSnapshot): DependencyIndex {
  const dependents = new Map<string, Dependent[]>();
  const references = new Map<string, Set<string>>();
  const triggerFunctions = new Map<string, Set<string>>();
  const add = (target: string, dependent: Dependent) => {
    const list = dependents.get(target) ?? [];
    list.push(dependent);
    dependents.set(target, list);
  };

  for (const view of snapshot.views ?? []) {
    for (const source of view.dependsOn ?? []) {
      add(source, {
        kind: view.materialized ? "materialized view" : "view",
        name: view.name,
        via: "reads it",
      });
    }
  }
  for (const table of snapshot.tables) {
    for (const fk of table.foreignKeys) {
      if (!fk.referencedTable) continue;
      const sameSchema = fk.referencedSchema === null || fk.referencedSchema === snapshot.schema;
      if (!sameSchema) continue;
      add(fk.referencedTable, {
        kind: "table (foreign key)",
        name: table.name,
        via: `fk ${fk.name} (${fk.columns.join(", ")}) on delete ${fk.onDelete.toLowerCase()}`,
      });
      const set = references.get(table.name) ?? new Set<string>();
      set.add(fk.referencedTable);
      references.set(table.name, set);
    }
    for (const trigger of table.triggers ?? []) {
      add(table.name, { kind: "trigger", name: trigger.name, via: `calls ${trigger.functionName}` });
      const set = triggerFunctions.get(table.name) ?? new Set<string>();
      set.add(trigger.functionName);
      triggerFunctions.set(table.name, set);
    }
  }
  const order = ["view", "materialized view", "table (foreign key)", "trigger"];
  for (const list of dependents.values()) {
    list.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
  }

  return {
    dependentsOf: (name) => [...(dependents.get(name) ?? [])],
    referencesOf: (table) => [...(references.get(table) ?? [])].sort(),
    triggerFunctionsOf: (table) => [...(triggerFunctions.get(table) ?? [])].sort(),
  };
}

/** One line per dependent, for a prompt. Routines are always "unknown". */
export function describeDependents(index: DependencyIndex, name: string): string {
  const list = index.dependentsOf(name);
  if (list.length === 0) return `${name}: nothing in this schema is known to use it (functions: unknown)`;
  return `${name}: ${list.map((d) => `${d.kind} ${d.name} (${d.via})`).join("; ")}; functions: unknown`;
}
