"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CheckIcon } from "./icons";

export type SetupStep = {
  key: string;
  label: string;
  done: boolean;
  /** One short line under the label, such as who can do it. */
  detail?: ReactNode;
  /** The button for an unfinished step. Leave it out when this person can't do the step. */
  action?: { label: string; href?: string; onClick?: () => void };
};

type SetupChecklistProps = {
  title: string;
  /** One line under the title, such as "Finish these and the deploy steps below open up." */
  lead?: ReactNode;
  steps: SetupStep[];
  /** Shows a Hide button (the Dashboard's Getting started list). */
  onHide?: () => void;
  /** Anything under the list, such as the locked steps a page unlocks. */
  children?: ReactNode;
  className?: string;
};

/**
 * A short list of what is missing before a page or the app can do its job,
 * with a count ("1 of 3 done") and one button per unfinished step. Used by
 * blocked pages (Deploy without GitHub) and the Dashboard's Getting started.
 * Every blocked page answers three things: what is missing, who can fix it,
 * and what to press.
 */
export function SetupChecklist({ title, lead, steps, onHide, children, className }: SetupChecklistProps) {
  const done = steps.filter((s) => s.done).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return (
    <section className={["setup", className ?? ""].filter(Boolean).join(" ")} aria-label={title}>
      <div className="setup__head">
        <div>
          <h2 className="setup__title">{title}</h2>
          {lead && <p className="setup__lead">{lead}</p>}
        </div>
        <div className="setup__count">
          <span>
            {done} of {steps.length} done
          </span>
          {onHide && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onHide}>
              Hide
            </button>
          )}
        </div>
      </div>
      <div className="setup__bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ol className="setup__list">
        {steps.map((step, i) => (
          <li key={step.key} className={step.done ? "setup__step is-done" : "setup__step"}>
            <span className="setup__mark" aria-hidden="true">
              {step.done ? <CheckIcon size={14} /> : i + 1}
            </span>
            <div className="setup__text">
              <span className="setup__label">
                {step.label}
                <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
              </span>
              {step.detail && <span className="setup__detail">{step.detail}</span>}
            </div>
            {!step.done && step.action && (
              <span className="setup__action">
                {step.action.href ? (
                  <Link href={step.action.href} className="btn btn-secondary btn-sm">
                    {step.action.label}
                  </Link>
                ) : (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={step.action.onClick}>
                    {step.action.label}
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ol>
      {children}
    </section>
  );
}
