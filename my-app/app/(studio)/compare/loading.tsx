import { Skeleton, Card } from "@/components/ui";

// Instant skeleton shown the moment Compare is clicked. The page is a server
// component that, before it can render, connects to BOTH databases and reads
// their schemas (and diffs them) — several seconds against a remote/cold DB.
// Next.js renders this loading UI immediately while that work runs, so the
// navigation never feels stuck.
export default function CompareLoading() {
  return (
    <div className="px-8 py-8">
      {/* Static header renders instantly */}
      <div className="mb-4">
        <div className="section-title mb-2">Compare &amp; Author</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.018em]">
          Turn a diff into editable SQL.
        </h1>
        <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
          Pick two live PostgreSQL sources and we&apos;ll surface the differences and generate
          the migration to bridge them.
        </p>
      </div>

      {/* Source selectors loading */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr auto" }}>
        {[0, 1].map((i) => (
          <Card key={i} className="p-4 space-y-3">
            <Skeleton width={64} height={11} />
            <Skeleton width="100%" height={38} radius={8} />
            <Skeleton width="55%" height={32} radius={8} />
          </Card>
        ))}
        <div className="flex items-end">
          <Skeleton width={104} height={38} radius={8} />
        </div>
      </div>

      {/* Diff loading */}
      <div className="mt-6">
        <div className="flex items-center gap-2 mb-3">
          <Skeleton width={42} height={16} />
          <Skeleton width={130} height={20} radius={999} />
        </div>
        <Card className="p-5 space-y-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between">
              <Skeleton width={`${38 + i * 9}%`} height={14} />
              <Skeleton width={60} height={20} radius={999} />
            </div>
          ))}
        </Card>
        <p className="help mt-3" style={{ color: "var(--text-3)" }}>
          Connecting to both databases and reading their schemas…
        </p>
      </div>
    </div>
  );
}
