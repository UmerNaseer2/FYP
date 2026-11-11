"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Drawer } from "@/components/ui/Drawer";
import { HelpIcon } from "@/components/ui/icons";
import { helpForPath, type HelpTopic } from "@/lib/help";

// The Help panel: one side panel for the whole studio, showing the help for
// the page you are on. The text lives in lib/help, one file per page.
//
// HelpProvider holds the panel and whether it is open. Anything inside it can
// open the panel with useHelp(): the Help button in the top bar and the one in
// each page's header both do.

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

  const open = useCallback(() => setIsOpen(true), []);
  const controls = useMemo(() => ({ open }), [open]);

  return (
    <HelpContext.Provider value={controls}>
      {children}
      <Drawer open={isOpen} onClose={() => setIsOpen(false)} title={`Help: ${topic.title}`} width={440}>
        <HelpTopicView topic={topic} />
      </Drawer>
    </HelpContext.Provider>
  );
}

/** The Help button. It draws nothing where there is no panel to open. */
export function HelpButton({ className = "btn btn-ghost btn-sm" }: { className?: string }) {
  const help = useHelp();
  if (!help) return null;
  return (
    <button type="button" className={className} onClick={help.open} aria-haspopup="dialog">
      <HelpIcon size={15} />
      <span>Help</span>
    </button>
  );
}

/** One page's help, laid out in the same four parts on every page. */
export function HelpTopicView({ topic }: { topic: HelpTopic }) {
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
            {topic.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
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
