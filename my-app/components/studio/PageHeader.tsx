"use client";

import { Fragment, type CSSProperties, type ReactNode } from "react";
import { HelpButton } from "@/components/help/HelpPanel";
import { helpForPage } from "@/lib/help";

type PageHeaderProps = {
  /** The page's key in lib/help, the same as its menu address: "/deploy". */
  page: string;
  /** Use a different title from the page's name, such as a tab's name. */
  title?: string;
  /** Use a different line from the page's blurb. Keep it to 15 words or fewer. */
  blurb?: string;
  /** Buttons shown on the right, before Help. */
  actions?: ReactNode;
  /** Anything that belongs under the title, such as tabs. */
  children?: ReactNode;
};

/**
 * The top of every studio page: the big title, one short line saying what
 * the page is for, and the Help button. The title and the line come from the
 * page's help file, so they are written in one place.
 *
 * Longer explanations do not go here. They go in the page's help file
 * (lib/help), which the Help button opens.
 */
export function PageHeader({ page, title, blurb, actions, children }: PageHeaderProps) {
  const topic = helpForPage(page);
  const text = title ?? topic.title;

  return (
    <header className="page-header">
      <div className="page-head">
        <div className="page-head__text">
          <PageTitle text={text} />
          <p className="page-sub">{blurb ?? topic.blurb}</p>
        </div>
        <div className="page-head__actions">
          {actions}
          <HelpButton className="btn btn-secondary btn-sm" />
        </div>
      </div>
      {children}
    </header>
  );
}

/**
 * The title, with each word rising into place one after another. The spaces
 * between the words stay plain text, so the heading still reads as one line
 * to a screen reader and to a search.
 */
export function PageTitle({ text }: { text: string }) {
  const words = text.split(" ");
  return (
    <h1 className="page-title">
      {words.map((word, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className="w">
            <span style={{ "--d": i * 60 } as CSSProperties}>{word}</span>
          </span>
        </Fragment>
      ))}
    </h1>
  );
}
