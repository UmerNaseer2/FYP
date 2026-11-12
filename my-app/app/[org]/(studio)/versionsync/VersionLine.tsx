"use client";

import { useEffect, useRef } from "react";
import { AlertTriangleIcon, CheckIcon } from "@/components/ui/icons";
import { countOf } from "@/lib/plural";

/**
 * Where one of the Source's versions stands on the Target:
 *   has  = the Target has it too
 *   next = missing, and a replay can run it
 *   stop = missing, and every run stops before it
 *   wait = missing, behind the version runs stop before
 *   past = missing, but the Target is already above it in that script group
 */
export type LineState = "has" | "next" | "stop" | "wait" | "past";

export type LineStep = {
  key: string;
  /** "v1.2.0", or the script group and the version when there are several groups. */
  label: string;
  state: LineState;
};

const STATE_WORDS: Record<LineState, string> = {
  has: "on the Target",
  next: "can run",
  stop: "runs stop here",
  wait: "waits",
  past: "Target is past it",
};

/**
 * The Source's ledger drawn as one line, oldest first, with a pin where the
 * Target has got to. It only draws what the two ledgers say.
 */
export function VersionLine({ steps }: { steps: LineStep[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  // The newest versions are the ones a replay is about, so a long line opens
  // at its far end. The key changes when the line does.
  const lineKey = steps.map((step) => step.key + step.state).join("|");
  useEffect(() => {
    const box = scroller.current;
    if (box) box.scrollLeft = box.scrollWidth;
  }, [lineKey]);

  // The Target's pin sits on the newest Source version it has.
  let targetAt = -1;
  steps.forEach((step, index) => {
    if (step.state === "has") targetAt = index;
  });
  const sourceAt = steps.length - 1;

  return (
    <section className="card vs-line" aria-label="The Source's versions">
      <div className="vs-lh">
        <h2>The Source&apos;s versions</h2>
        <span>
          {`${countOf(steps.length, "version")} applied, oldest first.`}
          {targetAt === -1 ? " The Target has none of them yet." : ""}
        </span>
      </div>
      <div className="vs-scroll" ref={scroller} tabIndex={0} role="group" aria-label="Version line, scrolls sideways">
        <ol className="vs-track">
          {steps.map((step, index) => {
            const after = index < sourceAt ? steps[index + 1].state : null;
            return (
              <li
                key={step.key}
                className={`vs-step vs-step--${step.state}${after ? ` vs-after--${after}` : ""}`}
              >
                <span className="vs-pins">
                  {index === targetAt && <span className="vs-pin vs-pin--target">Target</span>}
                  {index === sourceAt && <span className="vs-pin">Source</span>}
                </span>
                <span className="vs-tag mono">{step.label}</span>
                <span className="vs-mk" aria-hidden="true">
                  {step.state === "has" && <CheckIcon size={14} />}
                  {step.state === "stop" && <AlertTriangleIcon size={13} />}
                </span>
                <span className="vs-word">{STATE_WORDS[step.state]}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
