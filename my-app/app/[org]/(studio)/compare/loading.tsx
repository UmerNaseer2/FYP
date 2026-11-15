import "@/app/styles/atelier-compare.css";
import { Skeleton } from "@/components/ui";
import { PageHeader } from "@/components/studio/PageHeader";

// Shown the moment Compare & Author is opened, while the page itself loads.
// It has the same header and the same picker card as the real page, so
// nothing jumps when the page takes over.
export default function CompareLoading() {
  return (
    <div className="cp-page">
      <PageHeader page="/compare" />

      <div className="card cp-form" aria-hidden="true">
        <div className="cp-skel">
          <div>
            <Skeleton width={120} height={11} />
            <Skeleton height={56} radius={16} className="mt-2" />
          </div>
          <div>
            <Skeleton width={120} height={11} />
            <Skeleton height={56} radius={16} className="mt-2" />
          </div>
        </div>
      </div>

      <p className="cp-loading-say" role="status">
        <i aria-hidden="true" />
        Loading Compare &amp; Author…
      </p>
    </div>
  );
}
