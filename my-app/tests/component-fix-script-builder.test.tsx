/** @jest-environment jsdom */

/**
 * "Put these fixes in one script", the panel under the findings on both
 * Performance tabs.
 *
 * Three things here are worth a suite of their own.
 *
 * The first is the split between what a migration may hold and what it may
 * not. A migration is made for ONE schema — the one picked above the findings
 * — and the Analyse tab can suggest an index on a table in a different schema,
 * because the query read it there. If such a change ever slipped into the
 * saved draft, the Script Editor would version it, push it and deploy it as a
 * change to the picked schema, which it is not. Nothing on screen would say
 * so: the statement names its own schema and looks perfectly ordinary.
 *
 * The second is that the ticks are remembered with the list they were made on.
 * Run the analysis again and the findings are a different list; an untick made
 * on the old one must not land on whatever row now sits at that position. It
 * is done by derivation rather than by an effect (`unticked.items === items`),
 * which is the right way round but leaves nothing on screen to show which list
 * the ticks belong to — so only a test can tell the two apart.
 *
 * The third is that every note beside Save has to agree with what Save will
 * actually do. They are the only warning anyone gets before the script leaves
 * this panel, and they are worked out from the same helpers the script is, so
 * what they must not do is drift: promise a rollback that will not be there,
 * or stay quiet about the change being left behind.
 *
 * What is NOT here:
 *  - The script text itself. buildFixScript, changesWithoutUndo,
 *    fixScriptFileName, otherSchemas, schemasPhrase, listedFixes and
 *    startingUnticked are pure and have their own suite in
 *    tests/perf-sql.test.ts. This one checks what the panel asks them for and
 *    what it does with the answer, not how they answer.
 *  - saveMigrationDraft's own storage handling, in tests/migration-draft.test.ts.
 *  - The other end of the hand-over, where the Script Editor offers to load
 *    the draft (MigrationDraftBanner).
 *  - "Copied" turning back into "Copy as one script" after a second and a
 *    half. That is a timing claim, and the notice's other job — going away
 *    when the findings change underneath it — is pinned below.
 *  - The real clipboard and the real download. jsdom has neither
 *    navigator.clipboard nor URL.createObjectURL, so both are stubbed here.
 *    What is pinned is the text the panel hands them and the name it asks for,
 *    not that a browser does anything with either.
 *  - The bypass branch of useUser. BYPASS_AUTH is read at module load from
 *    NEXT_PUBLIC_AUTH_BYPASS, which next/jest does not load under
 *    NODE_ENV=test, so it is false here — which is what makes the role gate
 *    below testable at all. lib/auth-mode's own switch is covered by
 *    tests/auth-role-and-bypass.test.ts, and the hook's behaviour on both
 *    sides of it by tests/use-user.test.tsx.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import { FixScriptBuilder, type FixScriptTarget } from "@/components/studio/FixScriptBuilder";
import { readMigrationDraftRaw, type MigrationDraft } from "@/lib/migration-draft";
import type { FixScriptItem } from "@/lib/perf-sql";
import { resetPageState, routerCalls, setSessionLoading, setUser } from "./helpers/render-page";

/* ----------------------------------------------------------------- fixtures */

const TARGET: FixScriptTarget = {
  connectionId: "7",
  connectionName: "Prod shop",
  database: "shop",
  schema: "public",
};

/** A change to the picked schema, with the statement that takes it back out. */
const anIndex: FixScriptItem = {
  title: "Add an index for the customer filter",
  object: "public.invoices",
  fix: 'CREATE INDEX "invoices_customer_id_idx" ON "public"."invoices" ("customer_id");',
  undo: 'DROP INDEX "public"."invoices_customer_id_idx";',
  fixKind: "change",
};

const aSecondIndex: FixScriptItem = {
  title: "Add an index for the date range",
  object: "public.orders",
  fix: 'CREATE INDEX "orders_placed_at_idx" ON "public"."orders" ("placed_at");',
  undo: 'DROP INDEX "public"."orders_placed_at_idx";',
  fixKind: "change",
};

/**
 * The one the Analyse tab makes: the query read a table in another schema, so
 * the index goes on that table and no migration for `public` can carry it.
 */
const inAnotherSchema: FixScriptItem = {
  title: "Add an index for the joined lookup",
  object: "sales.leads",
  fix: 'CREATE INDEX "leads_owner_id_idx" ON "sales"."leads" ("owner_id");',
  undo: 'DROP INDEX "sales"."leads_owner_id_idx";',
  fixKind: "change",
  schemas: ["sales"],
};

const aVacuum: FixScriptItem = {
  title: "Vacuum the table",
  object: "public.invoices",
  fix: 'VACUUM ANALYZE "public"."invoices";',
  fixKind: "maintenance",
};

const withNoUndo: FixScriptItem = {
  title: "Drop the spare index",
  object: "public.invoices_customer_idx",
  fix: 'DROP INDEX "public"."invoices_customer_idx";',
  fixKind: "change",
};

const startsUnticked: FixScriptItem = {
  title: "Drop the invalid index",
  object: "public.orders_total_idx",
  fix: 'DROP INDEX "public"."orders_total_idx";',
  undo: 'CREATE INDEX "orders_total_idx" ON "public"."orders" ("total");',
  fixKind: "change",
  startUnticked: "The list of invalid indexes could not be read, so check this one first.",
};

const aRewrite: FixScriptItem = {
  title: "Select only the columns you use",
  object: "the customer report",
  fix: "SELECT id, name FROM invoices …",
  fixKind: "query",
};

const aDecision: FixScriptItem = {
  title: "Decide whether this table is still used",
  object: "public.old_leads",
  fix: "Nobody has read it in 90 days.",
  fixKind: "decision",
};

/* -------------------------------------------------------- browser stand-ins */

let copied: string[] = [];
let clipboardRefuses = false;
let downloads: { name: string; blob: Blob }[] = [];
let lastBlob: Blob | null = null;

/**
 * jsdom will not download anything, and clicking an <a href="blob:…"> makes it
 * log a "navigation not implemented" error over every test that downloads. So
 * the click is caught here and the name and the Blob are kept instead.
 */
const realAnchorClick = HTMLAnchorElement.prototype.click;

beforeAll(() => {
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: lastBlob as Blob });
  };
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    lastBlob = obj as Blob;
    return "blob:fix-script";
  };
  URL.revokeObjectURL = () => {};
});

afterAll(() => {
  HTMLAnchorElement.prototype.click = realAnchorClick;
});

beforeEach(() => {
  resetPageState();
  copied = [];
  clipboardRefuses = false;
  downloads = [];
  lastBlob = null;
  sessionStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (clipboardRefuses) return Promise.reject(new Error("blocked"));
        copied.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  cleanup();
});

/* ------------------------------------------------------------------ helpers */

function show(items: FixScriptItem[], target: Partial<FixScriptTarget> = {}) {
  return render(<FixScriptBuilder items={items} target={{ ...TARGET, ...target }} />);
}

/** The tick beside a row, found by the row's title. */
const tick = (title: string) =>
  within(screen.getByText(title).closest("label") as HTMLElement).getByRole("checkbox");

const copyButton = () => screen.getByRole("button", { name: /Copy as one script|Copied/ });
const downloadButton = () => screen.getByRole("button", { name: "Download .sql" });
const saveButton = () => screen.getByRole("button", { name: "Save as a migration" });
const intro = () => screen.getByText(/Every schema change and maintenance fix/);

/** The last thing Copy put on the clipboard, once the promise behind it has settled. */
async function copyScript() {
  fireEvent.click(copyButton());
  await waitFor(() => expect(copied).toHaveLength(1));
  return copied[0];
}

/**
 * The text inside a downloaded Blob. jsdom's Blob has no .text(), so it is
 * read the long way round, which is what the browsers without it need too.
 */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** The draft the Script Editor would find, as it would read it. */
function savedDraft(): MigrationDraft | null {
  const raw = readMigrationDraftRaw();
  return raw === null ? null : (JSON.parse(raw) as MigrationDraft);
}

/* -------------------------------------------------------------------- tests */

describe("when there is nothing to put in a script", () => {
  it("draws nothing at all rather than an empty panel", () => {
    // A rewrite changes the query and a decision needs a person, so neither
    // has a statement to put in a file. A panel headed "Put these fixes in one
    // script" over no fixes would be a button that cannot do anything.
    const { container } = show([aRewrite, aDecision]);

    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing for no findings at all", () => {
    const { container } = show([]);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("the three groups a fix can be in", () => {
  it("keeps the picked schema's changes, the other schema's and the maintenance apart", () => {
    show([anIndex, inAnotherSchema, aVacuum]);

    expect(
      screen.getByText("Changes to schema public (1) · save them as a migration")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Changes to schema sales (1) · copy or download them")
    ).toBeInTheDocument();
    expect(screen.getByText("Maintenance (1) · run it by hand")).toBeInTheDocument();
  });

  it("says just “Schema changes” when nothing is to another schema", () => {
    // Naming the schema is only worth the words when there is another one to
    // tell it from. With one group of changes there is nothing to confuse.
    show([anIndex, aVacuum]);

    expect(
      screen.getByText("Schema changes (1) · save them as a migration")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Changes to schema/)).not.toBeInTheDocument();
  });

  it("leaves out a group with nothing in it", () => {
    show([anIndex]);

    expect(screen.queryByText(/^Maintenance/)).not.toBeInTheDocument();
    expect(screen.queryByText(/copy or download them$/)).not.toBeInTheDocument();
  });

  it("names each row by its title and the object it is about", () => {
    show([anIndex]);

    expect(screen.getByText("Add an index for the customer filter")).toBeInTheDocument();
    expect(screen.getByText("public.invoices")).toBeInTheDocument();
  });

  it("counts every fix in the group, hidden by the severity filter or not", () => {
    show([anIndex, aSecondIndex, withNoUndo]);

    expect(
      screen.getByText("Schema changes (3) · save them as a migration")
    ).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("says why the rewrites and decisions are missing, and only when some are", () => {
    show([anIndex, aRewrite, aDecision]);
    expect(
      screen.getByText(/Query rewrites and decisions are not listed/)
    ).toBeInTheDocument();
    expect(screen.queryByText("Select only the columns you use")).not.toBeInTheDocument();

    cleanup();
    show([anIndex]);
    expect(screen.queryByText(/Query rewrites and decisions are not listed/)).not.toBeInTheDocument();
  });
});

describe("which rows start with their tick on", () => {
  it("ticks everything, because every listed fix is one the app stands behind", () => {
    show([anIndex, inAnotherSchema, aVacuum]);

    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();
  });

  it("leaves off the tick of a fix the app could not fully check, and says why", () => {
    // Off rather than hidden: the finding is probably still right, and the
    // reader can look at the index for themselves. Without the sentence the
    // row would look like one somebody had already decided against.
    show([anIndex, startsUnticked]);

    expect(tick("Drop the invalid index")).not.toBeChecked();
    expect(tick("Add an index for the customer filter")).toBeChecked();
    expect(
      screen.getByText("The list of invalid indexes could not be read, so check this one first.")
    ).toBeInTheDocument();
  });

  it("leaves an unticked fix out of the script until it is ticked", async () => {
    show([anIndex, startsUnticked]);

    expect(await copyScript()).not.toContain("orders_total_idx");

    copied.length = 0;
    fireEvent.click(tick("Drop the invalid index"));
    expect(await copyScript()).toContain('DROP INDEX "public"."orders_total_idx";');
  });
});

describe("analysing again goes back to the starting ticks", () => {
  it("does not carry an untick onto a different list of findings", () => {
    // The ticks are positions in the list, and a new analysis is a new list:
    // position 0 may now be a different fix entirely. Carrying the untick over
    // would quietly drop a fix nobody chose to drop.
    const { rerender } = render(<FixScriptBuilder items={[anIndex, aSecondIndex]} target={TARGET} />);
    fireEvent.click(tick("Add an index for the customer filter"));
    expect(tick("Add an index for the customer filter")).not.toBeChecked();

    rerender(<FixScriptBuilder items={[{ ...anIndex }, aSecondIndex]} target={TARGET} />);

    expect(tick("Add an index for the customer filter")).toBeChecked();
  });

  it("keeps the unticks while the findings stay the same list", () => {
    // The other half of the rule, and the half that makes it a rule rather
    // than a reset: a render caused by anything else — a parent re-rendering,
    // the tick beside it moving — must leave the choice alone.
    const items = [anIndex, aSecondIndex];
    const { rerender } = render(<FixScriptBuilder items={items} target={TARGET} />);
    fireEvent.click(tick("Add an index for the customer filter"));

    rerender(<FixScriptBuilder items={items} target={{ ...TARGET }} />);

    expect(tick("Add an index for the customer filter")).not.toBeChecked();
  });

  it("does not leave a notice from the old findings over the new ones", async () => {
    const items = [anIndex];
    const { rerender } = render(<FixScriptBuilder items={items} target={TARGET} />);
    fireEvent.click(copyButton());
    await screen.findByRole("button", { name: "Copied" });

    rerender(<FixScriptBuilder items={[{ ...anIndex }]} target={TARGET} />);

    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    expect(copyButton()).toHaveTextContent("Copy as one script");
  });
});

describe("copying the script", () => {
  it("puts every ticked fix in one script, in the order the groups are printed", async () => {
    show([anIndex, inAnotherSchema, aVacuum]);

    const script = await copyScript();

    expect(script).toContain('CREATE INDEX "invoices_customer_id_idx"');
    expect(script).toContain('CREATE INDEX "leads_owner_id_idx"');
    expect(script).toContain('VACUUM ANALYZE "public"."invoices";');
    // The order matters to whoever runs the file top to bottom: the migration's
    // changes, then what has to be run by hand elsewhere, then the maintenance
    // that cannot run inside a transaction at all.
    expect(script.indexOf("invoices_customer_id_idx")).toBeLessThan(
      script.indexOf("leads_owner_id_idx")
    );
    expect(script.indexOf("leads_owner_id_idx")).toBeLessThan(script.indexOf("VACUUM"));
  });

  it("leaves out whatever is unticked", async () => {
    show([anIndex, aSecondIndex]);
    fireEvent.click(tick("Add an index for the customer filter"));

    const script = await copyScript();

    expect(script).not.toContain("invoices_customer_id_idx");
    expect(script).toContain("orders_placed_at_idx");
  });

  it("says it copied, on the button that did it", async () => {
    show([anIndex]);

    fireEvent.click(copyButton());

    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("is dead with nothing ticked, and says what to do about it", async () => {
    show([anIndex]);
    fireEvent.click(tick("Add an index for the customer filter"));

    expect(copyButton()).toBeDisabled();
    expect(copyButton()).toHaveAttribute("title", "Tick at least one fix.");
    expect(downloadButton()).toBeDisabled();
  });

  it("points at Download when the browser blocks the clipboard", async () => {
    // Copy needs a permission a page not served over HTTPS does not have.
    // Download needs none, so the way out is named rather than implied.
    clipboardRefuses = true;
    show([anIndex]);

    fireEvent.click(copyButton());

    expect(
      await screen.findByText("Your browser blocked the clipboard. Use Download .sql instead.")
    ).toBeInTheDocument();
    expect(copyButton()).toHaveTextContent("Copy as one script");
  });
});

describe("downloading the script", () => {
  it("downloads the same text under a name made from the database and schema", async () => {
    show([anIndex, aVacuum]);

    fireEvent.click(downloadButton());

    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^performance-fixes-shop-public-\d{4}-\d{2}-\d{2}\.sql$/);
    const text = await blobText(downloads[0].blob);
    expect(text).toContain('CREATE INDEX "invoices_customer_id_idx"');
    expect(text).toContain('VACUUM ANALYZE "public"."invoices";');
  });

  it("downloads only what is ticked", async () => {
    show([anIndex, aSecondIndex]);
    fireEvent.click(tick("Add an index for the date range"));

    fireEvent.click(downloadButton());

    const text = await blobText(downloads[0].blob);
    expect(text).toContain("invoices_customer_id_idx");
    expect(text).not.toContain("orders_placed_at_idx");
  });
});

describe("who is offered a migration at all", () => {
  it("does not offer it to a viewer, and says which role it needs", () => {
    // The Script Editor saves through /api/github/push, which turns a viewer
    // away. Offering the button would spend somebody's time on a refusal at
    // the far end of the flow.
    setUser("viewer");
    show([anIndex]);

    expect(screen.queryByRole("button", { name: "Save as a migration" })).not.toBeInTheDocument();
    expect(screen.getByText("Saving as a migration needs the editor role.")).toBeInTheDocument();
  });

  it("says nothing about roles while next-auth has not answered yet", () => {
    // Not knowing the role is not the same as knowing it is too low. Saying
    // "you need the editor role" to an editor for a frame would be a lie the
    // page corrects a moment later, which is worse than saying nothing.
    setSessionLoading();
    show([anIndex]);

    expect(screen.queryByRole("button", { name: "Save as a migration" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Saving as a migration needs the editor role.")
    ).not.toBeInTheDocument();
  });

  it("offers it to an editor and to an admin, because the rule is “at least”", () => {
    setUser("editor");
    show([anIndex]);
    expect(saveButton()).toBeInTheDocument();

    cleanup();
    setUser("admin");
    show([anIndex]);
    expect(saveButton()).toBeInTheDocument();
  });

  it("does not offer it when nothing in the list could go in a migration", () => {
    // Maintenance tidies this one server; a change to another schema belongs
    // to another migration. Neither has anything for the Script Editor.
    show([inAnotherSchema, aVacuum]);

    expect(screen.queryByRole("button", { name: "Save as a migration" })).not.toBeInTheDocument();
  });
});

describe("what Save hands to the Script Editor", () => {
  it("hands over the picked schema's changes only, and opens the editor", () => {
    show([anIndex, inAnotherSchema, aVacuum]);

    fireEvent.click(saveButton());

    const draft = savedDraft();
    expect(draft?.sql).toContain('CREATE INDEX "invoices_customer_id_idx"');
    // The whole point of the split. A migration for public that quietly
    // created an index in sales would be deployed as a change to public.
    expect(draft?.sql).not.toContain("leads_owner_id_idx");
    expect(draft?.sql).not.toContain("VACUUM");
    expect(routerCalls.push).toEqual(["/script-editor"]);
  });

  it("carries the connection and schema the findings came from", () => {
    show([anIndex], { connectionId: "12", schema: "public" });

    fireEvent.click(saveButton());

    expect(savedDraft()).toMatchObject({ connectionId: "12", schema: "public" });
    expect(savedDraft()?.description).toContain("Add an index for the customer filter");
  });

  it("fills the rollback in, last change first", () => {
    show([anIndex, aSecondIndex]);

    fireEvent.click(saveButton());

    const rollback = savedDraft()?.rollbackSql ?? "";
    expect(rollback).toContain('DROP INDEX "public"."invoices_customer_id_idx";');
    expect(rollback.indexOf("orders_placed_at_idx")).toBeLessThan(
      rollback.indexOf("invoices_customer_id_idx")
    );
  });

  it("hands over no rollback at all when one ticked change has no undo", () => {
    // Not a partial one. A rollback that quietly skipped a change would leave
    // the database half put back while reporting it was done.
    show([anIndex, withNoUndo]);

    fireEvent.click(saveButton());

    expect(savedDraft()?.rollbackSql).toBeNull();
    expect(savedDraft()?.sql).toContain("invoices_customer_idx");
  });

  it("says so and stays put when the browser blocks site storage", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("site storage blocked");
    });
    show([anIndex]);

    fireEvent.click(saveButton());

    expect(screen.getByText(/Your browser is blocking site storage/)).toBeInTheDocument();
    // Opening the Script Editor on a draft that was never stored would land
    // the reader on an empty editor with no idea why.
    expect(routerCalls.push).toEqual([]);
  });
});

describe("Save is dead until there is something for it to take", () => {
  it("is dead when only another schema's change is ticked, and names the picked one", () => {
    show([anIndex, inAnotherSchema]);
    fireEvent.click(tick("Add an index for the customer filter"));

    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute(
      "title",
      "Tick at least one change to schema public. Only those go in a migration made here."
    );
  });

  it("drops the schema from the message when there is no other schema to confuse it with", () => {
    show([anIndex, aVacuum]);
    fireEvent.click(tick("Add an index for the customer filter"));

    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute(
      "title",
      "Tick at least one schema change. Only schema changes go in a migration."
    );
  });

  it("comes back to life the moment a change is ticked again", () => {
    show([anIndex]);
    fireEvent.click(tick("Add an index for the customer filter"));
    expect(saveButton()).toBeDisabled();

    fireEvent.click(tick("Add an index for the customer filter"));

    expect(saveButton()).toBeEnabled();
  });
});

describe("what the notes beside Save promise", () => {
  it("promises the rollback when every ticked change has an undo", () => {
    show([anIndex, aSecondIndex]);

    expect(
      screen.getByText(/Saving fills in the rollback too/)
    ).toBeInTheDocument();
  });

  it("names the change that would leave the rollback empty, and follows the ticks", () => {
    show([anIndex, withNoUndo]);
    expect(screen.getByText(/Saving leaves the rollback empty/)).toHaveTextContent(
      "Drop the spare index (public.invoices_customer_idx)"
    );

    fireEvent.click(tick("Drop the spare index"));

    expect(screen.queryByText(/Saving leaves the rollback empty/)).not.toBeInTheDocument();
    expect(screen.getByText(/Saving fills in the rollback too/)).toBeInTheDocument();
  });

  it("says a change to another schema cannot go in a migration made here", () => {
    show([anIndex, inAnotherSchema]);

    expect(screen.getByText(/A migration made here is for schema public/)).toHaveTextContent(
      "so the change to schema sales cannot go in one. Copy or download it instead."
    );
  });

  it("counts those changes when there is more than one of them", () => {
    // Worth pinning because the sentence is built from the ticked rows rather
    // than from the list: untick one of the two and it has to go back to the
    // singular, or it names a change nobody is saving.
    const another: FixScriptItem = {
      ...inAnotherSchema,
      title: "Add an index for the owner lookup",
      object: "sales.accounts",
      fix: 'CREATE INDEX "accounts_owner_id_idx" ON "sales"."accounts" ("owner_id");',
    };
    show([anIndex, inAnotherSchema, another]);
    expect(screen.getByText(/A migration made here is for schema public/)).toHaveTextContent(
      "so the changes to schema sales cannot go in one. Copy or download them instead."
    );

    fireEvent.click(tick("Add an index for the owner lookup"));

    expect(screen.getByText(/A migration made here is for schema public/)).toHaveTextContent(
      "so the change to schema sales cannot go in one. Copy or download it instead."
    );
  });

  it("says maintenance stays out of the migration when there is one to stay out of", () => {
    show([anIndex, aVacuum]);

    expect(screen.getByText(/Maintenance stays out of the migration/)).toBeInTheDocument();
  });

  it("explains maintenance differently when there is nothing else ticked", () => {
    // Nothing to stay out of, so the sentence has to say what a migration is
    // for instead of what maintenance is not part of.
    show([aVacuum]);

    expect(
      screen.getByText(/Only schema changes go in a migration. Run maintenance by hand/)
    ).toBeInTheDocument();
  });

  it("says none of it to someone who is not being offered Save", () => {
    setUser("viewer");
    show([anIndex, inAnotherSchema, aVacuum]);

    expect(screen.queryByText(/Saving fills in the rollback too/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A migration made here is for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Maintenance stays out/)).not.toBeInTheDocument();
  });
});

describe("the sentence at the top", () => {
  it("mentions saving a migration only when one is on offer", () => {
    show([anIndex]);

    expect(intro()).toHaveTextContent(
      "Or save the schema changes as a migration: the Script Editor opens"
    );
  });

  it("names the picked schema in it once another schema is in the list", () => {
    show([anIndex, inAnotherSchema]);

    expect(intro()).toHaveTextContent("Or save the changes to schema public as a migration");
  });

  it("stops at the ticks for a viewer, who has no migration to be told about", () => {
    setUser("viewer");
    show([anIndex]);

    expect(intro()).toHaveTextContent("download them as a .sql file.");
    expect(intro()).not.toHaveTextContent("Or save");
  });
});
