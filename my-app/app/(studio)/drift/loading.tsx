import { Skeleton, Card } from "@/components/ui";

// Drift is a server component that re-checks live drift against the latest
// snapshot (a DB round-trip) before rendering. Show an instant skeleton so the
// click registers immediately instead of hanging.
export default function DriftLoading() {
  return (
    <div className="px-8 py-8">
      <div className="mb-4">
        <div className="section-title mb-2">Drift</div>
        <Skeleton width={260} height={30} radius={6} />
      </div>

      {/* Tab bar */}
      <div className="flex gap-2 mb-5">
        <Skeleton width={120} height={34} radius={8} />
        <Skeleton width={110} height={34} radius={8} />
      </div>

      <Card className="p-5 space-y-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton width={`${30 + (i % 3) * 14}%`} height={14} />
            <Skeleton width={88} height={20} radius={999} />
          </div>
        ))}
      </Card>
      <p className="help mt-3" style={{ color: "var(--text-3)" }}>
        Re-checking live drift against the latest snapshot…
      </p>
    </div>
  );
}
