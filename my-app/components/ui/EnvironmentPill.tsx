import { Pill } from "./Pill";
import { ENVIRONMENT_META, type Environment } from "@/lib/environments";

/**
 * The dev / staging / prod label, drawn the same way everywhere it appears —
 * connections, the dashboard, drift, a schema's detail page and both sides of
 * a comparison. One component so a production target can never look calmer on
 * one screen than on another.
 *
 * The title is the environment's own one-line explanation. No label draws
 * nothing: a label is optional, and an empty one is not a warning.
 */
export function EnvironmentPill({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  if (environment === "unset") return null;
  const meta = ENVIRONMENT_META[environment];
  return (
    <Pill tone={meta.tone} className={className} title={meta.help}>
      {meta.label}
    </Pill>
  );
}
