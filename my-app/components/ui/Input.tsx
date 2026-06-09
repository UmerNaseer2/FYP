import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Use the monospace face — for hosts, URIs, identifiers. */
  mono?: boolean;
};

export function Input({ mono = false, className = "", ...props }: InputProps) {
  const classes = ["input", mono ? "mono" : "", className].filter(Boolean).join(" ");
  return <input className={classes} {...props} />;
}
