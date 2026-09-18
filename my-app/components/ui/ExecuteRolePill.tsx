import { Pill } from "./Pill";
import {
  describeExecuteRole,
  executeRoleBadge,
  type ExecuteRole,
} from "@/lib/connection-access";

/**
 * "Read-only" / "Admins only" beside a connection's name, drawn the same way
 * wherever a target is named — the connections table, the compare target
 * header, the deploy workbench.
 *
 * Returns null for the default setting, on purpose. Every connection has one of
 * these, so a pill on each of them would put the same words on every row and
 * stop being read. What is worth a badge is the connection that behaves
 * differently from the rest.
 *
 * "break" tone for read-only rather than a calm neutral: it is the setting that
 * makes the Deploy button refuse, and somebody scanning for why theirs did
 * should find it at the same glance they find a production label.
 */
export function ExecuteRolePill({
  role,
  className,
}: {
  role: ExecuteRole;
  className?: string;
}) {
  const label = executeRoleBadge(role);
  if (!label) return null;

  return (
    <Pill
      tone={role === "none" ? "break" : "pending"}
      className={className}
      title={describeExecuteRole(role)}
    >
      {label}
    </Pill>
  );
}
