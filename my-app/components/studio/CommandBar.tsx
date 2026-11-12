"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  BellIcon,
  ChevronRightIcon,
  HelpIcon,
  MoonIcon,
  PlayIcon,
  SearchIcon,
  SignOutIcon,
  SparkIcon,
  SunIcon,
} from "@/components/ui/icons";
import { replayIntro } from "@/lib/intro";
import { OPEN_ASK_AI_EVENT } from "@/lib/studio-events";
import type { NavItem } from "./nav";

// The command bar: press Ctrl K (Cmd K on a Mac), or the search pill in the
// top bar, and type where you want to go or what you want to do.
//
// It lists the pages your role can open and a few actions (switch theme, Ask
// AI, Help, Replay intro, Sign out). With nothing typed it shows what needs
// you first, then the last three things you picked, then every page.
//
// Typing ">" first shows only actions. Up and Down move, Enter runs the one
// that is lit, Escape closes it.

const RECENT_KEY = "schema-studio:recent-commands";

/** Extra words each page answers to, so "diff" finds Compare. */
const PAGE_WORDS: Record<string, string> = {
  "/studio": "home dashboard skyline overview",
  "/compare": "diff differences author",
  "/script-editor": "sql write query",
  "/deploy": "ship release run",
  "/versionsync": "versions migrations github",
  "/drift": "changes watch",
  "/performance": "speed slow queries",
  "/visualizer": "diagram tables map",
  "/connections": "databases hosts",
  "/requests": "approvals inbox",
  "/admin": "roles people permissions",
  "/history": "history activity log timeline",
  "/devices": "phone desktop pair link devices",
};

type Group = "Needs you" | "Recent" | "Pages" | "Actions";
type Scope = "all" | "pages" | "actions";

type Command = {
  id: string;
  group: "Pages" | "Actions";
  label: string;
  /** Shown under the label. */
  hint: string;
  /** Searched as well as the label. */
  words: string;
  icon: ReactNode;
  run: () => void;
};

type Row = Command & { shownIn: Group; score: number; span: [number, number] | null };

/**
 * How well `query` matches `text`, and which letters to underline.
 * The start of the text beats the start of a word, which beats the middle of
 * one, which beats letters scattered in order ("vsy" finds "Version Sync").
 * Null when it does not match at all.
 */
export function scoreMatch(query: string, text: string): [number, [number, number] | null] | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return [0, null];
  const at = t.indexOf(q);
  if (at === 0) return [100 - t.length * 0.1, [0, q.length]];
  if (at > 0) return [/[\s/&-]/.test(t[at - 1]) ? 80 : 60, [at, at + q.length]];
  if (q.length < 2) return null;
  let from = 0;
  let first = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, from);
    if (found < 0) return null;
    if (first < 0) first = found;
    from = found + 1;
  }
  return [34 - (from - first) * 0.6, null];
}

function readRecent(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}

function saveRecent(id: string) {
  try {
    const next = [id, ...readRecent().filter((r) => r !== id)].slice(0, 3);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the list just stays empty.
  }
}

/** The label with the matched letters underlined. */
function Highlight({ text, span }: { text: string; span: [number, number] | null }) {
  if (!span) return <>{text}</>;
  return (
    <>
      {text.slice(0, span[0])}
      <mark>{text.slice(span[0], span[1])}</mark>
      {text.slice(span[1])}
    </>
  );
}

type CommandBarProps = {
  open: boolean;
  onClose: () => void;
  /** The pages the rail offers, already with the organization in their address. */
  pages: NavItem[];
  /** The page you are on (its address with the organization). */
  activeHref: string;
  /** Requests waiting on you; above 0 it shows under "Needs you". */
  waiting: number;
  requestsHref?: string;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  /** Opens the Help panel, where there is one. */
  onHelp?: () => void;
  /** Whether Ask AI is switched on for this person. Off hides the action. */
  askAi?: boolean;
  onSignOut: () => void;
};

export function CommandBar(props: CommandBarProps) {
  // Mounting the panel only while open gives every opening a fresh, empty box.
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(<CommandPanel {...props} />, document.body);
}

function CommandPanel({
  onClose,
  pages,
  activeHref,
  waiting,
  requestsHref,
  theme,
  onToggleTheme,
  onHelp,
  askAi = false,
  onSignOut,
}: CommandBarProps) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [selected, setSelected] = useState(0);
  const [recent] = useState(readRecent);
  useDialogFocus(true, panelRef);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => router.push(href);
    const list: Command[] = pages.map((page) => {
      const key = Object.keys(PAGE_WORDS).find((path) => page.href === path || page.href.endsWith(path)) ?? "";
      return {
        id: `page:${key || page.href}`,
        group: "Pages",
        label: page.label,
        hint: page.href === activeHref ? "You are here" : "Page",
        words: PAGE_WORDS[key] ?? "",
        icon: page.icon,
        run: go(page.href),
      };
    });
    list.push({
      id: "act:theme",
      group: "Actions",
      label: theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme",
      hint: "Theme",
      words: "theme dark light mode colour color",
      icon: theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />,
      run: onToggleTheme,
    });
    if (askAi) {
      list.push({
        id: "act:ask-ai",
        group: "Actions",
        label: "Ask AI about your schema",
        hint: "Opens the schema chat",
        words: "ai chat ask question",
        icon: <SparkIcon />,
        run: () => window.dispatchEvent(new Event(OPEN_ASK_AI_EVENT)),
      });
    }
    if (onHelp) {
      list.push({
        id: "act:help",
        group: "Actions",
        label: "Help for this page",
        hint: "What this page is for and how to use it",
        words: "help guide how",
        icon: <HelpIcon size={16} />,
        run: onHelp,
      });
    }
    list.push({
      id: "act:intro",
      group: "Actions",
      label: "Replay intro",
      hint: "Plays the logo animation again",
      words: "intro logo animation",
      icon: <PlayIcon size={16} />,
      run: replayIntro,
    });
    list.push({
      id: "act:sign-out",
      group: "Actions",
      label: "Sign out",
      hint: "Everywhere you are signed in",
      words: "log out logout leave",
      icon: <SignOutIcon size={16} />,
      run: onSignOut,
    });
    return list;
  }, [pages, activeHref, theme, onToggleTheme, onHelp, askAi, onSignOut, router]);

  // ">" at the start means actions only.
  const actionsOnly = query.startsWith(">");
  const text = (actionsOnly ? query.slice(1) : query).trim();
  const effectiveScope: Scope = actionsOnly ? "actions" : scope;

  const rows = useMemo<Row[]>(() => {
    const inScope = commands.filter(
      (c) => effectiveScope === "all" || (effectiveScope === "pages" ? c.group === "Pages" : c.group === "Actions")
    );
    if (!text) {
      const out: Row[] = [];
      if (waiting > 0 && requestsHref && effectiveScope !== "actions") {
        out.push({
          id: "needs:requests",
          group: "Pages",
          shownIn: "Needs you",
          label: `${waiting} ${waiting === 1 ? "request is" : "requests are"} waiting on you`,
          hint: "Requests",
          words: "",
          icon: <BellIcon size={16} />,
          run: () => router.push(requestsHref),
          score: 0,
          span: null,
        });
      }
      for (const id of recent) {
        const c = inScope.find((x) => x.id === id);
        if (c) out.push({ ...c, shownIn: "Recent", score: 0, span: null });
      }
      for (const c of inScope) {
        if (!out.some((o) => o.id === c.id)) out.push({ ...c, shownIn: c.group, score: 0, span: null });
      }
      return out;
    }
    const matched: Row[] = [];
    for (const c of inScope) {
      const onLabel = scoreMatch(text, c.label);
      const onWords = c.words ? scoreMatch(text, c.words) : null;
      const best = onLabel ?? (onWords ? [onWords[0] - 20, null] as const : null);
      if (best) matched.push({ ...c, shownIn: c.group, score: best[0], span: onLabel ? onLabel[1] : null });
    }
    // Pages before actions, the best match first inside each.
    return matched.sort((a, b) => (a.group === b.group ? b.score - a.score : a.group === "Pages" ? -1 : 1));
  }, [commands, effectiveScope, text, waiting, requestsHref, recent, router]);

  const lit = rows.length === 0 ? -1 : Math.min(selected, rows.length - 1);

  function run(row: Row) {
    if (row.id !== "needs:requests") saveRecent(row.id);
    onClose();
    row.run();
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((lit + step + rows.length) % rows.length);
    } else if ((event.key === "Home" || event.key === "End") && !query) {
      event.preventDefault();
      setSelected(event.key === "Home" ? 0 : rows.length - 1);
    } else if (event.key === "Enter" && lit >= 0) {
      event.preventDefault();
      run(rows[lit]);
    }
  }

  // Keep the lit row in view as the arrows move it.
  const litId = lit >= 0 ? `ck-opt-${lit}` : undefined;
  const scrollLit = (el: HTMLDivElement | null) => el?.scrollIntoView?.({ block: "nearest" });

  const groups: Group[] = [];
  for (const row of rows) if (!groups.includes(row.shownIn)) groups.push(row.shownIn);

  const scopes: { value: Scope; label: string }[] = [
    { value: "all", label: "Everything" },
    { value: "pages", label: "Pages" },
    { value: "actions", label: "Actions" },
  ];

  return (
    <div
      className="studio-portal ck-wrap"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="ck"
        role="dialog"
        aria-modal="true"
        aria-label="Go to a page or run an action"
        tabIndex={-1}
        onKeyDown={onKey}
      >
        <div className="ck-in">
          <SearchIcon size={18} />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls="ck-list"
            aria-activedescendant={litId}
            aria-autocomplete="list"
            aria-label="Search pages and actions"
            placeholder="Where to? Type a page or an action"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="ck-sc" role="group" aria-label="Show">
          {scopes.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={effectiveScope === s.value}
              onClick={() => {
                setScope(s.value);
                if (actionsOnly) setQuery(query.slice(1));
                setSelected(0);
              }}
            >
              {s.label}
            </button>
          ))}
          <span className="ck-tip">
            Tip: start with <kbd>&gt;</kbd> for actions
          </span>
        </div>
        <div className="ck-l" id="ck-list" role="listbox" aria-label="Results">
          {groups.map((group) => (
            <div key={group} role="group" aria-label={group}>
              <div className="ck-g" aria-hidden="true">
                {group}
              </div>
              {rows.map((row, i) =>
                row.shownIn !== group ? null : (
                  <div
                    key={row.id + group}
                    id={`ck-opt-${i}`}
                    ref={i === lit ? scrollLit : undefined}
                    role="option"
                    aria-selected={i === lit}
                    className="ck-o"
                    onMouseMove={() => {
                      if (i !== lit) setSelected(i);
                    }}
                    onClick={() => run(row)}
                  >
                    <i aria-hidden="true">{row.icon}</i>
                    <span>
                      <b>
                        <Highlight text={row.label} span={row.span} />
                      </b>
                      <small>{row.hint}</small>
                    </span>
                    <em aria-hidden="true">
                      <ChevronRightIcon size={14} />
                    </em>
                  </div>
                )
              )}
            </div>
          ))}
          {rows.length === 0 && <p className="ck-no">Nothing matches “{text}”. Try a page name, such as Deploy.</p>}
        </div>
        <div className="ck-f">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span role="status" className="ck-count">
            {rows.length} {rows.length === 1 ? "result" : "results"}
          </span>
        </div>
      </div>
    </div>
  );
}
