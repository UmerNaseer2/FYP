"use client";

import type { ReactNode } from "react";
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
 * The top of every studio page: the title, one short line saying what the
 * page is for, and the Help button. The title and the line come from the
 * page's help file, so they are written in one place.
 *
 * Longer explanations do not go here. They go in the page's help file
 * (lib/help), which the Help button opens.
 */
export function PageHeader({ page, title, blurb, actions, children }: PageHeaderProps) {
  const topic = helpForPage(page);
  return (
    <header className="page-header mb-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-[-0.018em]">{title ?? topic.title}</h1>
          <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
            {blurb ?? topic.blurb}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-none">
          {actions}
          <HelpButton className="btn btn-sm" />
        </div>
      </div>
      {children}
    </header>
  );
}
