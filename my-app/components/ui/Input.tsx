import type { InputHTMLAttributes, Ref } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Use the monospace face — for hosts, URIs, identifiers. */
  mono?: boolean;
  /** To focus or select the box. React 19 hands it on to the input with the rest. */
  ref?: Ref<HTMLInputElement>;
};

export function Input({ mono = false, className = "", ...props }: InputProps) {
  const classes = ["input", mono ? "mono" : "", className].filter(Boolean).join(" ");
  return <input className={classes} {...props} />;
}
