"use client";

// ---------------------------------------------------------------------------
// The stops in front of anything that runs SQL: ProductionGate for "this
// target is production", RiskGate for every other risk (breaking changes,
// data loss, drift). They lived in the Deploy page; they live here so Version
// Sync's replay dialog stops a run with the same boxes and the same words.
// Moving them changed nothing about how they behave.
// ---------------------------------------------------------------------------
import { AlertTriangleIcon } from "@/components/ui/icons";

/**
 * The gate in front of anything that runs SQL on a production database.
 *
 * Everything else on this page can be undone or retried. This cannot: the
 * migration commits on a live database with real rows in it. So a production
 * target does not just get a louder colour, it gets a stop — the button below
 * stays disabled until someone reads this and ticks the box.
 *
 * The tick is deliberately per-action and short-lived. It is cleared whenever
 * the target, the schema, the script family or the version range changes, so it
 * can never be carried from the dev run you meant to the prod run you did not.
 */
export function ProductionGate({
  what,
  acknowledged,
  onAcknowledge,
  kind = "deploy",
}: {
  /** What is about to happen, in the user's words. "run 3 migrations", etc. */
  what: string;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  /**
   * Which warning to give. The deploy copy points at a rollback as the way
   * back for structure; a rollback cannot point at itself, so its copy says
   * what it cannot bring back instead.
   */
  kind?: "deploy" | "rollback";
}) {
  return (
    <div className="prod-gate">
      <div className="prod-gate__head">
        <AlertTriangleIcon size={15} className="ico" />
        <span>Production target</span>
      </div>
      {kind === "rollback" ? (
        <p className="prod-gate__body">
          This connection is labelled production. Live data is behind it. A
          rollback restores structure, not rows: rows it drops are gone, and rows
          the original migration deleted do not come back. If you need them, you
          need a backup.
        </p>
      ) : (
        <p className="prod-gate__body">
          This connection is labelled production. Live data is behind it, and a
          migration that goes wrong here is not something a rollback brings back —
          a rollback restores structure, not rows. If you need the rows back, you
          need a backup from before this run.
        </p>
      )}
      <label className="prod-gate__ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        <span>I understand, and I mean to {what} against production.</span>
      </label>
    </div>
  );
}

/**
 * A second stop, for a risk that is not "this is production".
 *
 * The Deploy screen used to print `breakingCount` and a red drift row and then
 * let you press Deploy anyway — information on screen that gated nothing. Each
 * of these now has to be read and ticked, for the same reason the production
 * gate exists: being on screen was not enough.
 */
export function RiskGate({
  tone,
  title,
  body,
  ack,
  acknowledged = false,
  onAcknowledge,
  children,
}: {
  /** "break" is red (a migration that destroys structure), "drift" is amber. */
  tone: "break" | "drift";
  title: string;
  body: string;
  /**
   * The sentence beside the checkbox, in the user's words.
   *
   * Optional, and leaving it out drops the checkbox — the panel then states
   * something true about the run that the reader cannot do anything about.
   * A tick box over a fact nobody can change is not a decision, it is a toll,
   * and every one of those makes the boxes that ARE decisions cheaper to tick
   * without reading.
   */
  ack?: string;
  acknowledged?: boolean;
  onAcknowledge?: (value: boolean) => void;
  /** Detail between the body and the checkbox, such as the list to check. */
  children?: React.ReactNode;
}) {
  return (
    <div className={tone === "drift" ? "prod-gate prod-gate--drift" : "prod-gate"}>
      <div className="prod-gate__head">
        <AlertTriangleIcon size={15} className="ico" />
        <span>{title}</span>
      </div>
      <p className="prod-gate__body">{body}</p>
      {children}
      {ack && (
        <label className="prod-gate__ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledge?.(event.target.checked)}
          />
          <span>{ack}</span>
        </label>
      )}
    </div>
  );
}
