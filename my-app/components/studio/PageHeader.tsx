"use client";

import { Fragment, type CSSProperties, type ReactNode } from "react";
import { helpForPage } from "@/lib/help";

type PageHeaderProps = {
  /** The page's key in lib/help, the same as its menu address: "/deploy". */
  page: string;
  /**
   * Only for a real name, such as a schema's name on its details page. Leave
   * it out everywhere else, so the title is the page's menu name. Slogans and
   * tab names do not go here: a slogan belongs in the blurb.
   */
  title?: string;
  /** Use a different line from the page's tagline. Keep it to 15 words or fewer. */
  blurb?: string;
  /** Buttons shown on the right. Help lives only in the top bar. */
  actions?: ReactNode;
  /** Anything that belongs under the title, such as PageTabs. */
  children?: ReactNode;
};

/**
 * The top of every studio page: the big title (the page's menu name, so the
 * menu, the title and Help all call the page the same thing) and one short
 * line under it, the page's tagline. Both come from the page's help file, so
 * they are written in one place. Help itself lives only in the top bar; a
 * page never adds a second Help button.
 *
 *   <PageHeader page="/admin" />
 *
 * Longer explanations do not go here. They go in the page's help file
 * (lib/help), which the top bar's Help opens.
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
        {actions && <div className="page-head__actions">{actions}</div>}
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
