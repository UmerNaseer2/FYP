// The help text for every page, one file per page in this folder.
//
// The rule for what goes where:
//   - On the page: warnings about losing data, and errors.
//   - In here: everything that explains how a page works.
// A page's file holds what the page is for, the steps, what its words mean and
// its common problems. The Help panel (components/help) shows it, and the
// shared page header shows its one-line blurb.
import { orgSlugFromPath } from "@/lib/org-slug";
import type { HelpTopic } from "./types";
import { generalHelp } from "./general";
import { studioHelp } from "./studio";
import { compareHelp } from "./compare";
import { scriptEditorHelp } from "./script-editor";
import { deployHelp } from "./deploy";
import { versionsyncHelp } from "./versionsync";
import { driftHelp } from "./drift";
import { performanceHelp } from "./performance";
import { visualizerHelp } from "./visualizer";
import { connectionsHelp } from "./connections";
import { requestsHelp } from "./requests";
import { adminHelp } from "./admin";
import { schemaDetailsHelp } from "./schema-details";
import { linkComputerHelp } from "./link-computer";
import { devicesHelp } from "./devices";
import { historyHelp } from "./history";

export type { HelpTopic, HelpTerm, HelpProblem, HelpSection } from "./types";

/** A blurb is the one line under a page's title, so it has to stay short. */
export const BLURB_MAX_WORDS = 15;

/**
 * Every page's help, keyed by the page's address without the organization
 * ("/deploy"), the same key the menu uses (components/studio/nav.tsx).
 */
export const HELP_TOPICS: Record<string, HelpTopic> = {
  "/studio": studioHelp,
  "/compare": compareHelp,
  "/script-editor": scriptEditorHelp,
  "/deploy": deployHelp,
  "/versionsync": versionsyncHelp,
  "/drift": driftHelp,
  "/performance": performanceHelp,
  "/visualizer": visualizerHelp,
  "/connections": connectionsHelp,
  "/requests": requestsHelp,
  "/admin": adminHelp,
  "/schemas": schemaDetailsHelp,
  "/link-computer": linkComputerHelp,
  "/devices": devicesHelp,
  "/history": historyHelp,
};

/** Shown where a page has no help of its own. */
export const GENERAL_HELP: HelpTopic = generalHelp;

/** The help for a page key such as "/deploy", or the general help. */
export function helpForPage(page: string): HelpTopic {
  return HELP_TOPICS[page] ?? GENERAL_HELP;
}

/**
 * The help for the page at this path. The organization at the front is set
 * aside first, so "/acme/deploy" and "/deploy" give the same answer, and
 * "/acme/schemas/12" gives the schema details help.
 */
export function helpForPath(pathname: string): HelpTopic {
  const slug = orgSlugFromPath(pathname);
  const route = slug === null ? pathname : pathname.slice(slug.length + 1);
  const key = Object.keys(HELP_TOPICS).find(
    (page) => route === page || route.startsWith(page + "/")
  );
  return key ? HELP_TOPICS[key] : GENERAL_HELP;
}
