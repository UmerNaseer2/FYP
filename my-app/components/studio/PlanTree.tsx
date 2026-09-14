"use client";

import { Pill } from "@/components/ui";
import { SEVERITY_META, type FindingSeverity } from "./FindingCard";
// Type-only: erased at build time. The shapes have one definition, in
// lib/query-analysis.ts, shared with the route that produces them.
import type { PlanStep, PlanSummary, QueryFinding } from "@/lib/query-analysis";
// Pure helpers from the same module (it opens no connections, so it is safe in
// the browser). The step list uses the same ones, so a box and its row can
// never word a number differently.
import {
  heaviestStepLabel,
  shareBand,
  shareLegend,
  shareText,
  stepFigures,
  subqueryCaption,
} from "@/lib/query-analysis";

/**
 * The plan as a tree of boxes. The box at the top hands the query its rows;
 * every other box feeds the one it hangs from.
 *
 * Plain nested lists, drawn by CSS (.plan-tree in globals.css), not a graph
 * library. A plan is always a tree (each step has exactly one parent), and a
 * tree is what nested ul/li already are; a layout engine would add a
 * dependency to solve a problem this shape does not have. The lines between
 * the boxes are borders on ::before/::after, the classic CSS org chart.
 *
 * A wide plan scrolls sideways inside its own frame rather than pushing the
 * whole page wider.
 */
export function PlanTree({
  plan,
  findings,
}: {
  plan: PlanSummary;
  /** Every finding on the screen; the ones with a stepId are counted on their box. */
  findings: QueryFinding[];
}) {
  const root = plan.steps[0];
  if (root === undefined) return null;

  // Each step's direct children, in plan order, from parentId. A step's id is
  // its position in plan.steps, so arrays indexed by id are enough.
  const children: PlanStep[][] = plan.steps.map(() => []);
  for (const step of plan.steps) {
    if (step.parentId !== null) children[step.parentId].push(step);
  }

  // The findings about each step, for the badge on its box. A finding about
  // the SQL text as a whole has no stepId and belongs to no box.
  const findingsOf: QueryFinding[][] = plan.steps.map(() => []);
  for (const finding of findings) {
    if (finding.stepId !== null) findingsOf[finding.stepId]?.push(finding);
  }

  const tree: TreeData = { plan, children, findingsOf };
  return (
    <div className="plan-tree-scroll">
      <ul className="plan-tree" aria-label="The query plan as a tree">
        <Branch step={root} tree={tree} />
      </ul>
    </div>
  );
}

/** What every box needs besides its own step, worked out once for the tree. */
type TreeData = {
  plan: PlanSummary;
  children: PlanStep[][];
  findingsOf: QueryFinding[][];
};

/**
 * One step's box, with the boxes of the steps that feed it underneath. Calls
 * itself for each of those, which is the whole of the tree layout.
 */
function Branch({ step, tree }: { step: PlanStep; tree: TreeData }) {
  const kids = tree.children[step.id];
  return (
    <li>
      <StepBox step={step} tree={tree} />
      {kids.length > 0 && (
        <ul>
          {kids.map((kid) => (
            <Branch key={kid.id} step={kid} tree={tree} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One step: its number, what it is, how many rows it handed on (and how many
 * times it ran), and its share of the query. Tinted red when it is half the
 * query or more and amber from a fifth, so the expensive part of a big plan
 * is visible before a word of it is read.
 */
function StepBox({ step, tree }: { step: PlanStep; tree: TreeData }) {
  const { plan } = tree;
  const figures = stepFigures(step, plan.measured);
  const caption = subqueryCaption(step);
  const found = tree.findingsOf[step.id];

  return (
    <div
      className={
        `plan-node plan-tint-${shareBand(step.share)}` + (caption !== null ? " plan-node-sub" : "")
      }
    >
      {/* A subquery runs on its own schedule (once, or once for every row
          of the step it hangs from), which its position alone does not say. */}
      {caption !== null && <div className="plan-node-caption">{caption}</div>}

      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[10.5px]" style={{ color: "var(--text-3)" }}>
          Step {step.id + 1}
        </span>
        {found.length > 0 && <FindingsBadge findings={found} />}
      </div>

      {/* The one-line meaning of the step type, on hover: the step list
          prints it in full. */}
      <div
        className="mono text-[12px] leading-[1.4] plan-node-label"
        style={{ color: "var(--text)" }}
        title={step.meaning || undefined}
      >
        {step.label}
      </div>

      <div className="mono text-[11px]" style={{ color: "var(--text-2)" }}>
        {figures.rows}
      </div>
      {figures.runs !== null && (
        <div className="mono text-[11px]" style={{ color: "var(--text-3)" }}>
          {figures.runs}
        </div>
      )}

      <div className="mt-1">
        <ShareMeter share={step.share} basis={plan.basis} />
      </div>

      {plan.heaviestStepId === step.id && (
        <div className="mt-1">
          <Pill tone="brand">{heaviestStepLabel(plan.basis)}</Pill>
        </div>
      )}
    </div>
  );
}

/**
 * A step's share of the query: a short bar and the number beside it. The
 * number is what a reader can quote; the bar lets a column of them be
 * compared at a glance. Red from half the query up, amber from a fifth, the
 * same bands as the tint (shareBand). Used by the tree and the step list.
 */
export function ShareMeter({ share, basis }: { share: number; basis: PlanSummary["basis"] }) {
  const band = shareBand(share);
  return (
    <div className="flex items-center gap-2" title={shareLegend(basis)}>
      {/* The bar repeats the number beside it, so it is decoration as far as
          a screen reader is concerned. */}
      <div className="plan-share-track" aria-hidden="true">
        <div
          className={`plan-share-fill plan-share-fill-${band}`}
          // A share too small to see still gets a sliver, so it reads as
          // "a little", not as "nothing".
          style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className={`mono text-[11px] plan-share-text-${band}`}>{shareText(share)}</span>
    </div>
  );
}

/** "2 findings", in the colour of the most serious of them. */
function FindingsBadge({ findings }: { findings: QueryFinding[] }) {
  const worst: FindingSeverity = findings.some((f) => f.severity === "high")
    ? "high"
    : findings.some((f) => f.severity === "medium")
      ? "medium"
      : "low";
  return (
    <Pill
      tone={SEVERITY_META[worst].tone}
      title="Listed under 'What to do about it' below, marked with this step's number"
    >
      {findings.length} finding{findings.length === 1 ? "" : "s"}
    </Pill>
  );
}
