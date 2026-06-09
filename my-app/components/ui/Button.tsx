import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

const sizeClass: Record<Size, string> = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
};

/** One button, four intents. Maps to the `.btn` design-system classes. */
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  const classes = ["btn", `btn-${variant}`, sizeClass[size], className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={classes} {...props} />;
}
