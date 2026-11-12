// ---------------------------------------------------------------------------
// The warning shown in front of anything that runs SQL: a breaking change,
// rows that will be deleted, drift on the target, other scripts applied since.
// It lives here so Deploy and Version Sync's replay dialog warn with the same
// box and the same words.
// ---------------------------------------------------------------------------
import { AlertTriangleIcon } from "@/components/ui/icons";

/**
 * A warning about one risk of the run that is about to happen.
 *
 * It only tells: there is no tick box and it disables nothing. Whether the
 * person may run at all is decided by their role, and by an approval when
 * their role does not allow it.
 */
export function RiskGate({
  tone,
  title,
  body,
  children,
}: {
  /** "break" is red (a migration that destroys structure), "drift" is amber. */
  tone: "break" | "drift";
  title: string;
  body: string;
  /** Detail under the body, such as the list to check. */
  children?: React.ReactNode;
}) {
  return (
    <div className={tone === "drift" ? "prod-gate prod-gate--drift" : "prod-gate"}>
      <div className="prod-gate__head">
        <AlertTriangleIcon size={15} className="ico" />
        <span>{title}</span>
      </div>
      <p className="prod-gate__body">{body}</p>
      {children}
    </div>
  );
}
