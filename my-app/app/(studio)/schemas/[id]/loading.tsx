import { Skeleton, Card } from "@/components/ui";

// The schema detail page reads a tracked schema's lineage (snapshots + history)
// server-side before rendering. Instant skeleton while that loads.
export default function SchemaDetailLoading() {
  return (
    <div className="max-w-[1100px] mx-auto px-8 py-10 space-y-8">
      {/* Header */}
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div className="space-y-2">
          <Skeleton width={90} height={11} />
          <Skeleton width={320} height={34} radius={6} />
          <Skeleton width={180} height={13} />
        </div>
        <div className="flex gap-2">
          <Skeleton width={100} height={34} radius={8} />
          <Skeleton width={88} height={34} radius={8} />
        </div>
      </header>

      {/* Current / HEAD card */}
      <Card className="p-5 space-y-3">
        <Skeleton width={70} height={11} />
        <Skeleton width="45%" height={22} />
        <Skeleton width="65%" height={14} />
      </Card>

      {/* Lineage */}
      <div>
        <div className="section-title mb-1">Lineage</div>
        <Card className="p-5 space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton width={28} height={28} radius={999} />
              <div className="flex-1 space-y-1.5">
                <Skeleton width={`${40 + i * 8}%`} height={14} />
                <Skeleton width="30%" height={11} />
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
