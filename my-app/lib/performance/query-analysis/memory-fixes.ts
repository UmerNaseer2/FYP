// Query analysis: the fixes for steps that ran out of memory.
//
// Holds the SQL suggested when a sort spilled to disk or a bitmap went lossy,
// both of which come down to work_mem.

import { fmtRows, oneLine } from "./wording";

/**
 * "4 MB" or "900 kB", for the sizes a plan reports in kB. Whole megabytes
 * from 10 MB up, one decimal below that.
 */
function kbText(kb: number): string {
  if (kb < 1024) return `${kb} kB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * The two narrow ways to raise work_mem to `size`, as comment lines.
 *
 * Narrow on purpose: work_mem is the memory EACH sort, hash or bitmap in each
 * running query may use, so a server-wide increase multiplies across every
 * busy connection and can run the server out of memory. One query (SET LOCAL,
 * which ends with its transaction) or one role is the safe scope. Commented,
 * because both findings that use this are decisions.
 */
function workMemLines(size: string): string[] {
  return [
    "-- work_mem is the memory each sort, hash or bitmap in each running query",
    "-- may use, so raising it for the whole server multiplies across every busy",
    "-- connection. Raise it only where it is needed:",
    "--   for this query only, run it in a transaction after",
    `--     SET LOCAL work_mem = '${size}';`,
    "--   for everything one role runs (a reporting login, say)",
    `--     ALTER ROLE "<role name>" SET work_mem = '${size}';`,
  ];
}

/**
 * The fix for a sort that spilled to disk: a decision, sized from what the
 * sort wrote when the plan says so ("external merge  Disk: 4096kB").
 *
 * In memory the same rows take more room than on disk, up to about three
 * times as much, so three times the disk figure (in whole megabytes, never
 * below the 4MB default) is the starting point. Without a figure the text
 * says so, rather than presenting a guess as a measurement.
 */
export function sortSpillFix(method: string, sortKey: string | null): string {
  const diskKb = Number(/Disk:\s*(\d+)\s*kB/i.exec(method)?.[1]);
  const sized = Number.isFinite(diskKb) && diskKb > 0;
  const size = sized ? `${Math.max(4, Math.ceil((diskKb * 3) / 1024))}MB` : "64MB";
  const lines = [
    "-- Decide whether to give this sort more memory (the work_mem setting).",
    ...(sized
      ? [
          `-- The sort wrote about ${kbText(diskKb)} to disk. In memory the same rows need`,
          `-- more room, up to about three times as much, so ${size} is a starting point.`,
        ]
      : [
          `-- The plan does not say how much the sort wrote to disk, so ${size} is only`,
          "-- a first guess.",
        ]),
    ...workMemLines(size),
    "-- The sort fitted when EXPLAIN ANALYZE of the query shows its Sort Method",
    '-- as "quicksort" instead of "external merge".',
  ];
  if (sortKey !== null) {
    lines.push(
      `-- Or avoid the sort: an index on ${oneLine(sortKey)} can return the rows`,
      "-- already in that order, when they come straight from one table."
    );
  }
  return lines.join("\n");
}

/**
 * The fix for a bitmap that ran out of memory: a decision. Unlike a sort, the
 * plan gives no size to start from, so the advice is to raise work_mem a step
 * at a time and watch the lossy pages go.
 */
export function lossyBitmapFix(lossyPages: number): string {
  return [
    "-- Decide whether to give this query more memory (the work_mem setting).",
    `-- The bitmap stopped tracking single rows on ${fmtRows(lossyPages)} pages. The plan does`,
    "-- not say how much memory would have been enough, so raise work_mem a step",
    "-- at a time (it is 4MB unless someone changed it; 16MB is a first step)",
    "-- until EXPLAIN ANALYZE of the query reports no lossy heap blocks.",
    ...workMemLines("16MB"),
  ].join("\n");
}
