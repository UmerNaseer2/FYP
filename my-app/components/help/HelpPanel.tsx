"use client";

import "./help.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { Drawer } from "@/components/ui/Drawer";
import { HelpIcon } from "@/components/ui/icons";
import { helpForPath, stepTarget, stepText, type HelpTopic } from "@/lib/help";
import { firstOnScreen } from "@/lib/tour";
import { Spotlight } from "./Spotlight";

// The Help panel: one side panel for the whole studio, showing the help for
// the page you are on. The text lives in lib/help, one file per page.
//
// HelpProvider holds the panel and whether it is open. Anything inside it can
// open the panel with useHelp(). The one Help button is in the top bar.
//
// Show me: a step that names a control on the page gets a "Show me" link.
// Pressing it closes Help and lights that control up (Spotlight.tsx).

/** A step someone asked to be shown: its words and the control's selector. */
type ShownStep = { text: string; target: string };

type HelpControls = { open: () => void };

const HelpContext = createContext<HelpControls | null>(null);

/** How to open the Help panel, or null where there is no panel (a page on its own in a test). */
export function useHelp(): HelpControls | null {
  return useContext(HelpContext);
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname() ?? "/";
  const topic = helpForPath(pathname);

  const [shown, setShown] = useState<ShownStep | null>(null);

  const open = useCallback(() => setIsOpen(true), []);
  const controls = useMemo(() => ({ open }), [open]);

  // Show me: Help gets out of the way, then the control is lit up.
  const showMe = useCallback((step: ShownStep) => {
    setIsOpen(false);
    setShown(step);
  }, []);
  const endShow = useCallback(() => setShown(null), []);

  return (
    <HelpContext.Provider value={controls}>
      {children}
      <Drawer open={isOpen} onClose={() => setIsOpen(false)} title={`Help: ${topic.title}`} width={440}>
        <HelpTopicView topic={topic} onShowMe={showMe} />
      </Drawer>
      {shown &&
        createPortal(
          <Spotlight target={shown.target} onDone={endShow}>
            {shown.text}
          </Spotlight>,
          document.body
        )}
    </HelpContext.Provider>
  );
}

/** The Help button. It draws nothing where there is no panel to open. */
export function HelpButton({ className = "btn btn-ghost btn-sm" }: { className?: string }) {
  const help = useHelp();
  if (!help) return null;
  return (
    <button type="button" className={className} onClick={help.open} aria-haspopup="dialog" data-help-button="">
      <HelpIcon size={15} />
      <span>Help</span>
    </button>
  );
}

type HelpTopicViewProps = {
  topic: HelpTopic;
  /** Called by a step's Show me link. Leave it out and no step gets a link. */
  onShowMe?: (step: ShownStep) => void;
};

/** One page's help, laid out in the same four parts on every page. */
export function HelpTopicView({ topic, onShowMe }: HelpTopicViewProps) {
  // The controls that are on the page right now, by selector. Looked up once,
  // when the panel opens, so a step about a control that is not there (another
  // tab, or a button this role does not get) has no link to nowhere.
  const [onPage, setOnPage] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!onShowMe) return;
    const found = new Set<string>();
    for (const step of topic.steps) {
      const target = stepTarget(step);
      if (target && firstOnScreen(target)) found.add(target);
    }
    // The page is only readable here, after the panel has been drawn.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnPage(found);
  }, [topic, onShowMe]);

  return (
    <div className="help-topic">
      <section>
        <h5>What this page is for</h5>
        <p>{topic.purpose || topic.blurb}</p>
      </section>

      {topic.steps.length > 0 && (
        <section>
          <h5>Steps</h5>
          <ol>
            {topic.steps.map((step, index) => {
              const text = stepText(step);
              const target = stepTarget(step);
              return (
                <li key={text}>
                  {text}
                  {onShowMe && target && onPage.has(target) && (
                    <button
                      type="button"
                      className="help-step__show"
                      aria-label={`Show me step ${index + 1}`}
                      onClick={() => onShowMe({ text, target })}
                    >
                      Show me <span aria-hidden="true">→</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {(topic.sections ?? []).map((section) => (
        <section key={section.title}>
          <h5>{section.title}</h5>
          {section.body.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </section>
      ))}

      {topic.terms.length > 0 && (
        <section>
          <h5>What the words mean</h5>
          <dl>
            {topic.terms.map((entry) => (
              <div key={entry.term}>
                <dt>{entry.term}</dt>
                <dd>{entry.meaning}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {topic.problems.length > 0 && (
        <section>
          <h5>Common problems</h5>
          <dl>
            {topic.problems.map((entry) => (
              <div key={entry.problem}>
                <dt>{entry.problem}</dt>
                <dd>{entry.fix}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
