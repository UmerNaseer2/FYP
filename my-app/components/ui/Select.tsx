"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

export type SelectOption = { value: string; label: string };

type SelectProps = {
  /**
   * When set, a hidden input with this name mirrors the value so a surrounding
   * <form> submits it without JS. Omit it for state-driven selects that react
   * via onChange instead.
   */
  name?: string;
  /** Current value. The component keeps its own state, seeded from this. */
  value: string;
  options: SelectOption[];
  /** Optional: called with the new value when the user picks an option. */
  onChange?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Render the trigger + option labels in the mono font (for identifiers/schemas). */
  mono?: boolean;
  /**
   * Trigger appearance:
   *  - "default": borderless, blends into a card (the Compare source picker).
   *  - "sub": borderless + smaller/muted (the Compare schema sub-line).
   *  - "input": boxed form control (border + surface + radius), like a text input.
   */
  variant?: "default" | "sub" | "input";
  ariaLabel?: string;
  /** Put on the trigger button, so a <label htmlFor> can associate with it. */
  id?: string;
  className?: string;
  /** Inline style on the root (e.g. a width constraint). */
  style?: CSSProperties;
};

function ChevronDown() {
  return (
    <svg
      className="ds-select__chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * Accessible select-only combobox (WAI-ARIA pattern). Focus stays on the
 * trigger; the active option is tracked with aria-activedescendant. A hidden
 * input mirrors the value so a plain <form> still submits it without any JS.
 */
export function Select({
  name,
  value: valueProp,
  options,
  onChange,
  disabled,
  placeholder,
  mono,
  variant = "default",
  ariaLabel,
  id,
  className,
  style,
}: SelectProps) {
  const [value, setValue] = useState(valueProp);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  // Re-seed if the parent value changes (e.g. a server re-render after submit).
  useEffect(() => {
    setValue(valueProp);
  }, [valueProp]);

  const selected = options.find((o) => o.value === value) ?? null;
  const displayLabel = selected ? selected.label : value || placeholder || "Select…";
  const isPlaceholder = !selected && !value;

  function commit(next: string) {
    setValue(next);
    onChange?.(next);
    setOpen(false);
  }

  function openMenu() {
    if (disabled) return;
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
    setOpen(true);
  }

  // Close when clicking or tapping outside.
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (activeIndex >= 0 && options[activeIndex]) commit(options[activeIndex].value);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <div ref={rootRef} className={`ds-select${className ? ` ${className}` : ""}`} style={style}>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        className={`ds-select__trigger${variant === "sub" ? " ds-select__trigger--sub" : ""}${variant === "input" ? " ds-select__trigger--input" : ""}${mono ? " mono" : ""}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={`ds-select__value${isPlaceholder ? " ds-select__placeholder" : ""}`}>
          {displayLabel}
        </span>
        <ChevronDown />
      </button>

      {open ? (
        <ul ref={listRef} id={listboxId} role="listbox" aria-label={ariaLabel} className="ds-select__list">
          {options.length === 0 ? (
            <li className="ds-select__empty" role="presentation">
              No options
            </li>
          ) : (
            options.map((opt, i) => (
              <li
                key={opt.value}
                id={optionId(i)}
                role="option"
                aria-selected={opt.value === value}
                className={`ds-select__option${mono ? " mono" : ""}${i === activeIndex ? " is-active" : ""}${opt.value === value ? " is-selected" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => commit(opt.value)}
              >
                <span className="ds-select__tick">{opt.value === value ? <Check /> : null}</span>
                <span className="ds-select__option-label">{opt.label}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
