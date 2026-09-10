/**
 * Query analysis — spec feature 08.
 *
 * Two halves are tested here for two different reasons.
 *
 * The plan reader is tested against hand-written EXPLAIN JSON because the real
 * thing is not available in a unit test and, more to the point, because the
 * interesting cases are the ones a healthy local database will never produce:
 * a sort that spilled to disk, an estimate out by fifty times, a nested loop
 * run ten thousand times. Fixtures are the only way to see them.
 *
 * The text rules are tested against queries that LOOK like they break a rule
 * but do not — the pattern inside a comment, the wildcard inside a string that
 * is not a LIKE pattern — because a linter that cries wolf gets switched off,
 * and every one of these rules is a heuristic.
 */

import {
  describePlan,
  readPlan,
  readSql,
  sortFindings,
  summarizeFindings,
} from "@/lib/query-analysis";

/** Ids of the findings a call produced, so a test can assert on membership. */
function ids(findings: { id: string }[]): string[] {
  return findings.map((f) => f.id);
}

/** A minimal EXPLAIN (FORMAT JSON) envelope around one plan node. */
function envelope(plan: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return [{ Plan: plan, ...extra }];
}

describe("readPlan", () => {
  it("returns null when handed something that is not a plan at all", () => {
    expect(readPlan(null)).toBe(null);
    expect(readPlan("QUERY PLAN")).toBe(null);
    expect(readPlan([{ notAPlan: true }])).toBe(null);
    expect(readPlan([{ Plan: { "Total Cost": 1 } }])).toBe(null);
  });

  it("accepts both the array envelope postgres sends and a bare plan object", () => {
    const node = { "Node Type": "Result", "Plan Rows": 1, "Total Cost": 0.01 };
    const fromArray = readPlan(envelope(node));
    const fromObject = readPlan({ Plan: node });
    expect(fromArray?.steps.length).toBe(1);
    expect(fromObject?.steps.length).toBe(1);
  });

  it("flattens the tree into parent-before-child order with a depth on each step", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Hash Join",
        "Plan Rows": 10,
        "Total Cost": 50,
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "a", "Plan Rows": 10, "Total Cost": 20 },
          {
            "Node Type": "Hash",
            "Plan Rows": 5,
            "Total Cost": 15,
            Plans: [
              { "Node Type": "Seq Scan", "Relation Name": "b", "Plan Rows": 5, "Total Cost": 10 },
            ],
          },
        ],
      })
    );
    expect(summary?.steps.map((s) => s.nodeType)).toEqual([
      "Hash Join",
      "Seq Scan",
      "Hash",
      "Seq Scan",
    ]);
    expect(summary?.steps.map((s) => s.depth)).toEqual([0, 1, 1, 2]);
  });

  it("names the table and the index in the step label", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        "Index Name": "orders_pkey",
        Alias: "o",
        "Plan Rows": 1,
        "Total Cost": 8,
      })
    );
    expect(summary?.steps[0].label).toBe("Index Scan using orders_pkey on orders o");
  });

  it("leaves the alias out of the label when it only repeats the table name", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Alias: "orders",
        "Plan Rows": 1,
        "Total Cost": 8,
      })
    );
    expect(summary?.steps[0].label).toBe("Seq Scan on orders");
  });

  it("puts the verb back into a ModifyTable label", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "ModifyTable",
        Operation: "Update",
        "Relation Name": "orders",
        "Plan Rows": 1,
        "Total Cost": 8,
      })
    );
    expect(summary?.steps[0].label).toBe("Update on orders");
  });

  it("explains the common node types in words", () => {
    const summary = readPlan(
      envelope({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 1, "Total Cost": 1 })
    );
    expect(summary?.steps[0].meaning).toContain("every row");
  });

  it("leaves the explanation empty rather than inventing one for an unknown node", () => {
    const summary = readPlan(
      envelope({ "Node Type": "Custom Scan", "Plan Rows": 1, "Total Cost": 1 })
    );
    expect(summary?.steps[0].meaning).toBe("");
  });

  it("reports the plan as unmeasured when it came from a plain EXPLAIN", () => {
    const summary = readPlan(
      envelope({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 3, "Total Cost": 9 })
    );
    expect(summary?.measured).toBe(false);
    expect(summary?.slowestStepId).toBe(null);
    expect(summary?.steps[0].actualRows).toBe(null);
  });

  it("subtracts child time so each step's own cost is what is reported", () => {
    // Parent 10 ms inclusive, child 8 ms — the parent itself did 2 ms of work.
    const summary = readPlan(
      envelope({
        "Node Type": "Hash Join",
        "Plan Rows": 1,
        "Total Cost": 10,
        "Actual Total Time": 10,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "t",
            "Plan Rows": 1,
            "Total Cost": 8,
            "Actual Total Time": 8,
            "Actual Rows": 1,
            "Actual Loops": 1,
          },
        ],
      })
    );
    expect(summary?.measured).toBe(true);
    expect(summary?.steps[0].selfMs).toBe(2);
    expect(summary?.steps[1].selfMs).toBe(8);
    expect(summary?.slowestStepId).toBe(1);
  });

  it("multiplies a repeated inner step's time by its loop count", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Nested Loop",
        "Plan Rows": 1,
        "Total Cost": 10,
        "Actual Total Time": 100,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Relation Name": "t",
            "Plan Rows": 1,
            "Total Cost": 1,
            "Actual Total Time": 0.05,
            "Actual Rows": 1,
            "Actual Loops": 1000,
          },
        ],
      })
    );
    // 0.05 ms a time, a thousand times, is 50 ms — not 0.05.
    expect(summary?.steps[1].selfMs).toBe(50);
    expect(summary?.steps[0].selfMs).toBe(50);
  });

  it("never reports a negative self time when the reported numbers round badly", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Limit",
        "Plan Rows": 1,
        "Total Cost": 1,
        "Actual Total Time": 0.5,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "t",
            "Plan Rows": 1,
            "Total Cost": 1,
            "Actual Total Time": 0.6,
            "Actual Rows": 1,
            "Actual Loops": 1,
          },
        ],
      })
    );
    expect(summary?.steps[0].selfMs).toBe(0);
  });

  it("carries the planning and execution times through", () => {
    const summary = readPlan(
      envelope(
        {
          "Node Type": "Seq Scan",
          "Relation Name": "t",
          "Plan Rows": 1,
          "Total Cost": 1,
          "Actual Total Time": 1,
          "Actual Rows": 1,
          "Actual Loops": 1,
        },
        { "Planning Time": 0.3, "Execution Time": 1.2 }
      )
    );
    expect(summary?.planningMs).toBe(0.3);
    expect(summary?.executionMs).toBe(1.2);
  });
});

describe("readPlan — findings", () => {
  it("flags a sequential scan over a large table", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        "Plan Rows": 50000,
        "Total Cost": 900,
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("seq-scan:"))).toBe(true);
    expect(summary?.findings[0].severity).toBe("high");
  });

  it("leaves a sequential scan of a small table alone", () => {
    // Reading forty rows in order is the right plan and always will be.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "currencies",
        "Plan Rows": 40,
        "Total Cost": 2,
      })
    );
    expect(summary?.findings).toEqual([]);
  });

  it("flags a selective scan of a large table once told how large it is", () => {
    // The case the whole rule exists for: the plan says one row comes back, so
    // the plan alone reads as harmless. The table's real size is what makes it
    // a whole-table read, and nothing in EXPLAIN carries that.
    const plan = envelope({
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      "Plan Rows": 1,
      "Total Cost": 900,
      Filter: "(reference = 'AB-1'::text)",
    });

    expect(readPlan(plan)?.findings).toEqual([]);

    const informed = readPlan(plan, { orders: 400000 });
    expect(ids(informed?.findings ?? [])).toContain("seq-scan:0");
    expect(informed?.findings[0].detail).toContain("400,000 rows");
    // It should say what the reader is actually getting for that work.
    expect(informed?.findings[0].detail).toContain("1 row is expected to match");
  });

  it("ignores a table size that is smaller than the plan's own estimate", () => {
    // reltuples is a stale estimate. When the planner expects more rows than
    // the statistics claim exist, the planner is the fresher of the two.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        "Plan Rows": 60000,
        "Total Cost": 900,
      }),
      { orders: 12 }
    );
    expect(summary?.findings[0].detail).toContain("60,000 rows");
  });

  it("does not apply a table size to a step that is not reading that table", () => {
    // "Sort" carries no Relation Name, so nothing should be looked up for it —
    // otherwise a sort of four rows inherits the size of the table below it.
    const summary = readPlan(
      envelope({
        "Node Type": "Sort",
        "Plan Rows": 4,
        "Total Cost": 10,
        Plans: [
          { "Node Type": "Index Scan", "Relation Name": "orders", "Plan Rows": 4 },
        ],
      }),
      { orders: 900000 }
    );
    // An index scan is not a whole-table read however big the table is, and the
    // sort above it is not a read at all.
    expect(summary?.findings).toEqual([]);
  });

  it("says how many rows a whole-table read threw away, formatted", () => {
    // The plan reports the count as a raw "Rows Removed by Filter: 39999".
    // Repeating that verbatim would put an unseparated number next to a
    // formatted one in the same sentence.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "events",
        Filter: "(kind = 'error'::text)",
        "Rows Removed by Filter": 39999,
        "Plan Rows": 1,
        "Total Cost": 900,
        "Actual Total Time": 40,
        "Actual Rows": 1,
        "Actual Loops": 1,
      }),
      { events: 40000 }
    );
    const seqScan = summary?.findings.find((f) => f.id === "seq-scan:0");
    expect(seqScan?.detail).toContain("39,999 of them are thrown away");
  });

  it("flags a filter that discards nearly everything it read", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "events",
        Filter: "(kind = 'error'::text)",
        "Rows Removed by Filter": 99000,
        "Plan Rows": 1000,
        "Total Cost": 900,
        "Actual Total Time": 40,
        "Actual Rows": 1000,
        "Actual Loops": 1,
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("wasteful-filter:"))).toBe(
      true
    );
  });

  it("does not flag a wasteful filter on a plan that was never run", () => {
    // Without ANALYZE there is no "rows removed" to compare against — the key
    // is simply absent, and guessing from the estimate would be a fabrication.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "events",
        Filter: "(kind = 'error'::text)",
        "Plan Rows": 1000,
        "Total Cost": 900,
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("wasteful-filter:"))).toBe(
      false
    );
  });

  it("flags an estimate that is out by an order of magnitude", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        "Index Name": "orders_customer_idx",
        "Plan Rows": 10,
        "Total Cost": 20,
        "Actual Total Time": 30,
        "Actual Rows": 4000,
        "Actual Loops": 1,
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("estimate-off:"))).toBe(true);
  });

  it("ignores an estimate that is off on a handful of rows", () => {
    // Two rows where one was expected is not stale statistics, it is rounding.
    const summary = readPlan(
      envelope({
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        "Index Name": "orders_pkey",
        "Plan Rows": 1,
        "Total Cost": 8,
        "Actual Total Time": 0.1,
        "Actual Rows": 2,
        "Actual Loops": 1,
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("estimate-off:"))).toBe(false);
  });

  it("flags a sort that spilled to disk", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Sort",
        "Sort Key": ["created_at"],
        "Sort Method": "external merge  Disk: 4096kB",
        "Plan Rows": 100,
        "Total Cost": 200,
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("sort-on-disk:"))).toBe(true);
  });

  it("leaves an in-memory sort alone", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Sort",
        "Sort Key": ["created_at"],
        "Sort Method": "quicksort  Memory: 25kB",
        "Plan Rows": 100,
        "Total Cost": 200,
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("sort-on-disk:"))).toBe(false);
  });

  it("flags a nested loop whose inner side ran thousands of times", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Nested Loop",
        "Plan Rows": 1,
        "Total Cost": 10,
        "Actual Total Time": 900,
        "Actual Rows": 5000,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "line_items",
            "Plan Rows": 1,
            "Total Cost": 1,
            "Actual Total Time": 0.1,
            "Actual Rows": 1,
            "Actual Loops": 5000,
          },
        ],
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("nested-loop:"))).toBe(true);
  });

  it("does not blame a nested loop for a busy node under a different join", () => {
    // The busy Seq Scan below sits one level under the OTHER join, at the same
    // depth as this loop's own child. Matching on depth alone across the whole
    // flattened plan attributed it to the quiet loop.
    const summary = readPlan(
      envelope({
        "Node Type": "Hash Join",
        "Plan Rows": 1,
        "Total Cost": 100,
        "Actual Total Time": 900,
        "Actual Rows": 10,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Nested Loop",
            "Plan Rows": 1,
            "Total Cost": 10,
            "Actual Total Time": 1,
            "Actual Rows": 2,
            "Actual Loops": 1,
            Plans: [
              {
                "Node Type": "Index Scan",
                "Relation Name": "customers",
                "Plan Rows": 1,
                "Total Cost": 1,
                "Actual Total Time": 0.1,
                "Actual Rows": 1,
                "Actual Loops": 2,
              },
            ],
          },
          {
            "Node Type": "Hash",
            "Plan Rows": 1,
            "Total Cost": 80,
            "Actual Total Time": 800,
            "Actual Rows": 1,
            "Actual Loops": 1,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Relation Name": "line_items",
                "Plan Rows": 1,
                "Total Cost": 79,
                "Actual Total Time": 700,
                "Actual Rows": 1,
                "Actual Loops": 5000,
              },
            ],
          },
        ],
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("nested-loop:"))).toBe(false);
  });

  it("flags a plan that uses no index anywhere over a large table", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Aggregate",
        "Plan Rows": 1,
        "Total Cost": 900,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "events",
            "Plan Rows": 90000,
            "Total Cost": 890,
          },
        ],
      })
    );
    expect(ids(summary?.findings ?? [])).toContain("no-index-anywhere");
  });

  it("does not call a function scan an unindexed table read", () => {
    // generate_series has no index to have missed.
    const summary = readPlan(
      envelope({
        "Node Type": "Function Scan",
        "Function Name": "generate_series",
        "Plan Rows": 10000,
        "Total Cost": 10,
      })
    );
    expect(ids(summary?.findings ?? [])).not.toContain("no-index-anywhere");
  });

  it("flags an index-only scan that kept going back to the table", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Index Only Scan",
        "Relation Name": "orders",
        "Index Name": "orders_pkey",
        "Heap Fetches": 40000,
        "Plan Rows": 100,
        "Total Cost": 40,
      })
    );
    expect(ids(summary?.findings ?? []).some((id) => id.startsWith("heap-fetches:"))).toBe(true);
  });

  it("puts the most serious finding first", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "events",
        "Sort Method": "external merge  Disk: 1kB",
        "Plan Rows": 90000,
        "Total Cost": 900,
      })
    );
    expect(summary?.findings[0].severity).toBe("high");
  });
});

describe("describePlan", () => {
  it("says the numbers are estimates when the query was not run", () => {
    const summary = readPlan(
      envelope({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 12, "Total Cost": 9 })
    );
    const line = describePlan(summary!);
    expect(line).toContain("estimates");
    expect(line).toContain("12");
  });

  it("reports the measured duration when the query was run", () => {
    const summary = readPlan(
      envelope(
        {
          "Node Type": "Seq Scan",
          "Relation Name": "t",
          "Plan Rows": 1,
          "Total Cost": 9,
          "Actual Total Time": 3,
          "Actual Rows": 42,
          "Actual Loops": 1,
        },
        { "Execution Time": 3.14 }
      )
    );
    const line = describePlan(summary!);
    expect(line).toContain("3.14 ms");
    expect(line).toContain("42 rows");
  });
});

describe("readSql", () => {
  it("flags SELECT *", () => {
    expect(ids(readSql("SELECT * FROM orders"))).toContain("select-star");
  });

  it("does not flag a named select list", () => {
    expect(ids(readSql("SELECT id, name FROM orders"))).not.toContain("select-star");
  });

  it("ignores a rule-breaking pattern that only appears in a comment", () => {
    const sql = "-- SELECT * FROM orders\nSELECT id FROM orders";
    expect(ids(readSql(sql))).not.toContain("select-star");
  });

  it("ignores a rule-breaking pattern inside a string literal", () => {
    const sql = "SELECT id FROM logs WHERE message = 'SELECT * FROM orders'";
    expect(ids(readSql(sql))).not.toContain("select-star");
  });

  it("flags a LIKE pattern that starts with a wildcard", () => {
    expect(ids(readSql("SELECT id FROM people WHERE name LIKE '%smith%'"))).toContain(
      "leading-wildcard"
    );
  });

  it("leaves a prefix LIKE alone, because an index can serve it", () => {
    expect(ids(readSql("SELECT id FROM people WHERE name LIKE 'smith%'"))).not.toContain(
      "leading-wildcard"
    );
  });

  it("does not read a percent sign in an unrelated string as a wildcard", () => {
    const sql = "SELECT id FROM reports WHERE title = '%complete' AND kind LIKE 'sales%'";
    expect(ids(readSql(sql))).not.toContain("leading-wildcard");
  });

  it("flags a function wrapped around the column being filtered", () => {
    expect(ids(readSql("SELECT id FROM users WHERE LOWER(email) = 'a@b.com'"))).toContain(
      "function-on-column"
    );
  });

  it("leaves a function on the other side of the comparison alone", () => {
    // LOWER($1) is computed once; the index on email is still usable.
    expect(ids(readSql("SELECT id FROM users WHERE email = LOWER($1)"))).not.toContain(
      "function-on-column"
    );
  });

  it("does not read a function in a later clause as one in the WHERE", () => {
    // HAVING runs after aggregation, so no index could have helped it either
    // way. The old rule matched anything between WHERE and the end of the
    // statement, which meant a following clause fired a finding about a WHERE
    // that wraps nothing.
    const sql =
      "SELECT email FROM users WHERE tenant = $1 GROUP BY email HAVING LOWER(email) = 'a@b.com'";
    expect(ids(readSql(sql))).not.toContain("function-on-column");
  });

  it("still reads the second of two WHERE clauses", () => {
    const sql =
      "SELECT id FROM a WHERE tenant = $1 UNION SELECT id FROM b WHERE LOWER(email) = 'a@b.com'";
    expect(ids(readSql(sql))).toContain("function-on-column");
  });

  it("flags NOT IN over a subquery", () => {
    const sql = "SELECT id FROM a WHERE id NOT IN (SELECT a_id FROM b)";
    expect(ids(readSql(sql))).toContain("not-in-subquery");
  });

  it("leaves NOT IN over a literal list alone", () => {
    expect(ids(readSql("SELECT id FROM a WHERE state NOT IN ('x', 'y')"))).not.toContain(
      "not-in-subquery"
    );
  });

  it("flags a comma join", () => {
    expect(ids(readSql("SELECT a.id FROM a, b WHERE b.a_id = a.id"))).toContain("comma-join");
  });

  it("does not read an explicit JOIN as a comma join", () => {
    expect(ids(readSql("SELECT a.id FROM a JOIN b ON b.a_id = a.id"))).not.toContain("comma-join");
  });

  it("flags an ORDER BY with no LIMIT", () => {
    expect(ids(readSql("SELECT id FROM orders ORDER BY created_at DESC"))).toContain(
      "order-by-no-limit"
    );
  });

  it("leaves a limited ORDER BY alone", () => {
    expect(ids(readSql("SELECT id FROM orders ORDER BY created_at DESC LIMIT 20"))).not.toContain(
      "order-by-no-limit"
    );
  });

  it("does not read a window function's own ordering as the result's", () => {
    // OVER (ORDER BY …) says how the window is numbered, not how many rows come
    // back, so a LIMIT would not change what this sorts.
    const sql = "SELECT id, row_number() OVER (ORDER BY created_at) FROM orders";
    expect(ids(readSql(sql))).not.toContain("order-by-no-limit");
  });

  it("flags a deep OFFSET", () => {
    const sql = "SELECT id FROM orders ORDER BY id LIMIT 20 OFFSET 40000";
    expect(ids(readSql(sql))).toContain("deep-offset");
  });

  it("leaves a shallow OFFSET alone, because page two is not the problem", () => {
    const sql = "SELECT id FROM orders ORDER BY id LIMIT 20 OFFSET 20";
    expect(ids(readSql(sql))).not.toContain("deep-offset");
  });

  it("flags SELECT DISTINCT", () => {
    expect(ids(readSql("SELECT DISTINCT customer_id FROM orders"))).toContain("select-distinct");
  });

  it("flags an unfiltered COUNT(*)", () => {
    expect(ids(readSql("SELECT COUNT(*) FROM orders"))).toContain("unfiltered-count");
  });

  it("leaves a filtered COUNT(*) alone", () => {
    expect(ids(readSql("SELECT COUNT(*) FROM orders WHERE state = 'paid'"))).not.toContain(
      "unfiltered-count"
    );
  });

  it("flags an UPDATE with no WHERE clause, and calls it serious", () => {
    const findings = readSql("UPDATE orders SET state = 'paid'");
    expect(ids(findings)).toContain("write-without-where");
    expect(findings[0].severity).toBe("high");
  });

  it("leaves a filtered DELETE alone", () => {
    expect(ids(readSql("DELETE FROM orders WHERE id = 1"))).not.toContain("write-without-where");
  });

  it("finds nothing to say about a well-shaped query", () => {
    const sql =
      "SELECT o.id, o.total FROM orders o JOIN customers c ON c.id = o.customer_id " +
      "WHERE o.state = 'paid' ORDER BY o.created_at DESC LIMIT 20";
    expect(readSql(sql)).toEqual([]);
  });
});

describe("sortFindings", () => {
  it("orders high before medium before low", () => {
    const sorted = sortFindings([
      { id: "c", severity: "low", title: "", object: "", detail: "", fix: "" },
      { id: "a", severity: "high", title: "", object: "", detail: "", fix: "" },
      { id: "b", severity: "medium", title: "", object: "", detail: "", fix: "" },
    ]);
    expect(ids(sorted)).toEqual(["a", "b", "c"]);
  });

  it("leaves the original array untouched", () => {
    const input = [
      { id: "c", severity: "low" as const, title: "", object: "", detail: "", fix: "" },
      { id: "a", severity: "high" as const, title: "", object: "", detail: "", fix: "" },
    ];
    sortFindings(input);
    expect(ids(input)).toEqual(["c", "a"]);
  });
});

describe("summarizeFindings", () => {
  it("counts each severity and the total", () => {
    const counts = summarizeFindings([
      { id: "a", severity: "high", title: "", object: "", detail: "", fix: "" },
      { id: "b", severity: "low", title: "", object: "", detail: "", fix: "" },
      { id: "c", severity: "low", title: "", object: "", detail: "", fix: "" },
    ]);
    expect(counts).toEqual({ high: 1, medium: 0, low: 2, total: 3 });
  });

  it("counts an empty list as all zeroes", () => {
    expect(summarizeFindings([])).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
  });
});
