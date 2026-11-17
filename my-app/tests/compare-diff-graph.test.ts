// The map of changes in Compare: one card per table, coloured by what the
// script does to it, with the links between them. Its counts must agree with
// the tiles above it.
import { compareSchemas } from "@/lib/compare/diff";
import { buildDiffGraph, diffNodeId } from "@/components/studio/visualizer/diff-graph";
import type { ConstraintSnapshot, ForeignKeySnapshot } from "@/lib/postgres";
import { column, schema, table } from "./helpers/snapshots";

const id = (name: string) => column(name, { isPrimaryKey: true, nullable: false });
const pkey = (name: string): ConstraintSnapshot => ({
  name,
  kind: "PRIMARY KEY",
  columns: ["id"],
  definition: "PRIMARY KEY (id)",
  normalizedDefinition: "PRIMARY KEY (id)",
});
const fk: ForeignKeySnapshot = {
  name: "books_author_fk",
  kind: "FOREIGN KEY",
  columns: ["author_id"],
  definition: "FOREIGN KEY (author_id) REFERENCES authors(id)",
  normalizedDefinition: "FOREIGN KEY (author_id) REFERENCES authors(id)",
  referencedSchema: "public",
  referencedTable: "authors",
  referencedColumns: ["id"],
  onUpdate: "NO ACTION",
  onDelete: "NO ACTION",
};

function report() {
  const source = schema([
    table("authors", [id("id"), column("name", { typeDisplay: "text" })], {
      primaryKey: pkey("authors_pkey"),
    }),
    table("books", [id("id"), column("author_id")], {
      primaryKey: pkey("books_pkey"),
      foreignKeys: [fk],
    }),
    table("tags", [id("id")]),
  ]);
  const target = schema([
    table("authors", [id("id"), column("name", { typeDisplay: "varchar(50)" })], {
      primaryKey: pkey("authors_pkey"),
    }),
    table("tags", [id("id")]),
    table("old_logs", [id("id")]),
  ]);
  return compareSchemas(source, target);
}

describe("buildDiffGraph", () => {
  it("gives every table a card coloured by what happens to it", () => {
    const graph = buildDiffGraph(report());
    const status = Object.fromEntries(graph.nodes.map((node) => [node.data.label, node.data.status]));
    expect(status).toEqual({ books: "add", authors: "chg", tags: "same", old_logs: "rem" });
    expect(graph.counts).toEqual({ add: 1, chg: 1, rem: 1, same: 1 });
    expect(graph.nodes.map((node) => node.id)).toContain(diffNodeId("rem", "old_logs"));
  });

  it("marks the changed column inside a changed table", () => {
    const authors = buildDiffGraph(report()).nodes.find((node) => node.data.label === "authors")!;
    const name = authors.data.rows.find((row) => row.name === "name")!;
    expect(name.status).toBe("chg");
    expect(authors.data.hasChg).toBe(true);
  });

  it("draws a link only the source has as added", () => {
    const graph = buildDiffGraph(report());
    expect(graph.edges).toEqual([
      expect.objectContaining({
        source: diffNodeId("add", "books"),
        target: diffNodeId("chg", "authors"),
        status: "add",
        label: "books_author_fk",
      }),
    ]);
  });

  it("leaves out unchanged tables when asked, but still counts them", () => {
    const graph = buildDiffGraph(report(), { onlyChanged: true });
    expect(graph.nodes.map((node) => node.data.label).sort()).toEqual(["authors", "books", "old_logs"]);
    expect(graph.counts.same).toBe(1);
  });

  it("lays every card out at a real position", () => {
    for (const node of buildDiffGraph(report()).nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
      expect(node.width).toBeGreaterThan(0);
    }
  });
});
