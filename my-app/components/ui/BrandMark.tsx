import { useId, type SVGProps } from "react";

// The Schema Studio mark: two rounded squares, one orange and one ink, with
// the place they overlap cut out. Two versions of one thing, which is what
// the app compares all day.
//
// The colours come from the theme tokens, so it flips with light and dark.
// The rects carry the classes "a" and "b" so the sidebar can give each its own
// little entrance (.side .brand in app/globals.css).

type BrandMarkProps = SVGProps<SVGSVGElement> & { size?: number };

export function BrandMark({ size = 30, ...props }: BrandMarkProps) {
  // Each mark on the page needs its own clip path id. useId's characters are
  // not all safe inside url(#...), so keep only the plain ones.
  const clipId = "bm" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true" {...props}>
      <defs>
        <clipPath id={clipId}>
          <rect x="2" y="2" width="18" height="18" rx="6" />
        </clipPath>
      </defs>
      <rect className="a" x="2" y="2" width="18" height="18" rx="6" fill="var(--accent)" />
      <rect className="b" x="10" y="10" width="18" height="18" rx="6" fill="var(--ink)" />
      <rect x="10" y="10" width="18" height="18" rx="6" fill="var(--bg)" clipPath={`url(#${clipId})`} />
    </svg>
  );
}
