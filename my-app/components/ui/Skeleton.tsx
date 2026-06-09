type SkeletonProps = {
  className?: string;
  width?: number | string;
  height?: number | string;
  /** Border radius override; defaults to the token-driven 4px. */
  radius?: number | string;
};

/** Shimmering placeholder block for loading states. */
export function Skeleton({ className = "", width, height = 16, radius }: SkeletonProps) {
  return (
    <div
      className={["sk", className].filter(Boolean).join(" ")}
      style={{ width, height, borderRadius: radius }}
    />
  );
}
