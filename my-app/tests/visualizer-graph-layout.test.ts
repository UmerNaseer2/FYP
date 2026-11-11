// The Schema Visualizer's layout for big schemas (components/studio/visualizer/graph.ts).
//
// dagre gives every rank of the foreign key graph its own column and never
// wraps. A chain of 60 tables came out as one line about 21,000 px wide, and a
// table with 60 others pointing at it as one column about 13,000 px tall. Fit
// View then shrank the picture until no table name could be read. buildGraph
// now reflows such a layout into a block close to the shape of a screen.
//
// What is NOT here: the drawing itself (React Flow), which jsdom cannot lay out.
import { buildGraph, type VizGraph, type VizNode } from "../components/studio/visualizer/graph";
import type { ForeignKeySnapshot, TableSnapshot } from "../lib/postgres";
import { column, schema, table } from "./helpers/snapshots";

/** A foreign key from the column `<to>_id` to `<to>.id`. */
function fkTo(to: string): ForeignKeySnapshot {
  return {
    name: `fk_${to}`,
    kind: "FOREIGN KEY",
    columns: [`${to}_id`],
    definition: `FOREIGN KEY (${to}_id) REFERENCES ${to}(id)`,
    normalizedDefinition: `FOREIGN KEY (${to}_id) REFERENCES ${to}(id)`,
    referencedSchema: "public",
    referencedTable: to,
    referencedColumns: ["id"],
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
  };
}

/** A table with an id and three more columns, pointing at `refs`. */
function tableWith(name: string, refs: string[] = []): TableSnapshot {
  const columns = [column("id"), column("name"), column("created_at"), column("note")];
  for (const ref of refs) columns.push(column(`${ref}_id`));
  return table(name, columns, { foreignKeys: refs.map(fkTo) });
}

const name = (i: number) => `t${String(i).padStart(2, "0")}`;

/** t00 <- t01 <- t02 ... : every table points at the one before it. */
function chain(count: number): TableSnapshot[] {
  return Array.from({ length: count }, (_, i) => tableWith(name(i), i === 0 ? [] : [name(i - 1)]));
}

/** One hub table that every other table points at. */
function star(count: number): TableSnapshot[] {
  return [tableWith("hub"), ...Array.from({ length: count }, (_, i) => tableWith(name(i), ["hub"]))];
}

/** The width and height of the whole picture. */
function size(graph: VizGraph): { width: number; height: number } {
  const left = Math.min(...graph.nodes.map((n) => n.position.x));
  const top = Math.min(...graph.nodes.map((n) => n.position.y));
  const right = Math.max(...graph.nodes.map((n) => n.position.x + n.width));
  const bottom = Math.max(...graph.nodes.map((n) => n.position.y + n.height));
  return { width: right - left, height: bottom - top };
}

/** True when two table boxes cover some of the same area. */
function overlap(a: VizNode, b: VizNode): boolean {
  return (
    a.position.x < b.position.x + b.width &&
    b.position.x < a.position.x + a.width &&
    a.position.y < b.position.y + b.height &&
    b.position.y < a.position.y + a.height
  );
}

function expectNoOverlaps(graph: VizGraph) {
  for (let i = 0; i < graph.nodes.length; i += 1) {
    for (let j = i + 1; j < graph.nodes.length; j += 1) {
      if (overlap(graph.nodes[i], graph.nodes[j])) {
        throw new Error(`${graph.nodes[i].id} overlaps ${graph.nodes[j].id}`);
      }
    }
  }
}

describe("the visualizer's layout of a big schema", () => {
  it("wraps a chain of 60 tables instead of drawing one long line", () => {
    const graph = buildGraph(schema(chain(60)));
    const { width, height } = size(graph);

    // It was about 21,000 px wide and one table tall.
    expect(width).toBeLessThan(4500);
    expect(height).toBeLessThan(4500);
    expect(graph.nodes).toHaveLength(60);
    expectNoOverlaps(graph);
  });

  it("splits a column of 60 tables that all point at one table", () => {
    const graph = buildGraph(schema(star(60)));
    const { width, height } = size(graph);

    // It was about 13,000 px tall and two tables wide.
    expect(width).toBeLessThan(4500);
    expect(height).toBeLessThan(4500);
    expect(graph.nodes).toHaveLength(61);
    expectNoOverlaps(graph);
  });

  it("splits 60 tables with no foreign keys, which dagre stacks in one column", () => {
    const tables = Array.from({ length: 60 }, (_, i) => tableWith(name(i)));
    const graph = buildGraph(schema(tables));
    const { width, height } = size(graph);

    expect(width).toBeLessThan(4500);
    expect(height).toBeLessThan(4500);
    expectNoOverlaps(graph);
  });

  it("keeps a chain in order: along a row, then on to the next row", () => {
    const graph = buildGraph(schema(chain(60)));
    const at = (id: string) => graph.nodes.find((n) => n.id === id)!.position;

    // Walking the chain, the row changes only when a row is full: a table
    // never jumps back to a row the walk has already left.
    const rowsInOrder: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const y = at(name(i)).y;
      if (rowsInOrder[rowsInOrder.length - 1] !== y) rowsInOrder.push(y);
    }
    expect(rowsInOrder.length).toBeGreaterThan(1);
    expect(new Set(rowsInOrder).size).toBe(rowsInOrder.length);

    // And along one row, each table is one step further the same way.
    for (let i = 2; i < 60; i += 1) {
      const [a, b, c] = [at(name(i - 2)), at(name(i - 1)), at(name(i))];
      if (a.y === b.y && b.y === c.y) expect(Math.sign(c.x - b.x)).toBe(Math.sign(b.x - a.x));
    }
  });

  it("leaves a small schema exactly as dagre drew it", () => {
    // Five tables in a chain fit on a screen, so nothing is wrapped: they stay
    // in one row, each in its own column.
    const graph = buildGraph(schema(chain(5)));
    // dagre lines tables up by their middles, the wrap by their tops.
    const middles = new Set(graph.nodes.map((n) => Math.round(n.position.y + n.height / 2)));
    const xs = new Set(graph.nodes.map((n) => n.position.x));

    expect(middles.size).toBe(1);
    expect(xs.size).toBe(5);
  });

  it("gives the same layout every time", () => {
    const first = buildGraph(schema(star(60))).nodes.map((n) => n.position);
    const second = buildGraph(schema(star(60))).nodes.map((n) => n.position);

    expect(second).toEqual(first);
  });
});
