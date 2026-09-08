import { Pill } from "./Pill";
import { ENVIRONMENT_META, type Environment } from "@/lib/environments";

/**
 * The dev / staging / prod label, drawn the same way everywhere it appears —
 * connections, the dashboard, drift, a schema's detail page and both sides of
 * a comparison. One component so a production target can never look calmer on
 * one screen than on another.
 *
 * The title is the environment's own one-line explanation, so hovering an
 * "Unlabelled" pill says why that is worth fixing.
 */
export function EnvironmentPill({
  environment,
  className,
}: {
  environment: Environment;
  className?: string;
}) {
  const meta = ENVIRONMENT_META[environment];
  return (
    <Pill tone={meta.tone} className={className} title={meta.help}>
      {meta.label}
    </Pill>
  );
}
