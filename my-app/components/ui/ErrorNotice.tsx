"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useOrgHref } from "@/hooks/useOrg";
import { describeError } from "@/lib/friendly-error";
import { AlertCircleIcon, LockIcon } from "./icons";

type ErrorNoticeProps = {
  /** The message the API sent back. Nothing renders when it is empty. */
  error: string | null | undefined;
  /** The connection's name, so the headline can say "students_prod needs its password again". */
  connectionName?: string | null;
  /** The connection's id. "Enter the password again" opens it for editing on Connections. */
  connectionId?: string | number | null;
  /** Shows a Try again button where a retry can help (can't be reached, other errors). */
  onRetry?: () => void;
  /** Extra buttons after the notice's own. */
  actions?: ReactNode;
  /** "card" (the default) or "inline" for a tight spot such as under a picker. */
  variant?: "card" | "inline";
  className?: string;
};

/**
 * An error that says what happened, what to press, and keeps the server's
 * wording under Technical details. It reads the message with describeError
 * (lib/friendly-error) and picks the right next step:
 *
 * - a saved password this server cannot open: "Enter the password again",
 *   which opens the connection on Connections (/connections?edit=<id>)
 * - a database that didn't answer: Try again
 * - no schemas the role can read: Open Connections
 */
export function ErrorNotice({
  error,
  connectionName,
  connectionId,
  onRetry,
  actions,
  variant = "card",
  className,
}: ErrorNoticeProps) {
  const orgPath = useOrgHref();
  if (!error || !String(error).trim()) return null;
  const info = describeError(String(error), { connectionName });

  const editHref = orgPath(
    connectionId != null && connectionId !== ""
      ? `/connections?edit=${encodeURIComponent(String(connectionId))}`
      : "/connections",
  );

  const tone = info.kind === "no-schemas" ? "notice--quiet" : info.kind === "password" ? "notice--warn" : "notice--break";

  return (
    <div
      className={["notice", tone, variant === "inline" ? "notice--inline" : "", className ?? ""].filter(Boolean).join(" ")}
      role="alert"
    >
      <span className="notice__icon" aria-hidden="true">
        {info.kind === "password" ? <LockIcon size={18} /> : <AlertCircleIcon size={18} />}
      </span>
      <div className="notice__main">
        {info.title && <p className="notice__title">{info.title}</p>}
        <p className="notice__body">{info.body}</p>
        {(info.kind === "password" || info.kind === "no-schemas" || onRetry || actions) && (
          <div className="notice__actions">
            {info.kind === "password" && (
              <Link href={editHref} className="btn btn-primary btn-sm">
                Enter the password again
              </Link>
            )}
            {info.kind === "no-schemas" && (
              <Link href={orgPath("/connections")} className="btn btn-secondary btn-sm">
                Open Connections
              </Link>
            )}
            {(info.kind === "unreachable" || info.kind === "other") && onRetry && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
                Try again
              </button>
            )}
            {actions}
          </div>
        )}
        {info.technical && (
          <details className="notice__tech">
            <summary>Technical details</summary>
            <p>{info.technical}</p>
          </details>
        )}
      </div>
    </div>
  );
}
