"use client";

// The app tour: a welcome card, then one card per page with the part it talks
// about lit up, then a last card with somewhere to start. What it says, and
// when it is offered, live in lib/ui/tour.ts; this file only draws it.
//
// StudioShell draws <AppTour /> once, outside `.studio`, so while the tour is
// up the page behind it can be made inert (no clicks, no Tab stops) and the
// tour moves from page to page itself.
//
// The light itself (finding a part of the page, scrolling to it, placing the
// hole and the card) lives in lib/ui/tour.ts, so the Help panel's "Show me" links
// can use the same one (components/help/Spotlight.tsx).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { useOrg, useOrgHref } from "@/hooks/useOrg";
import type { PermissionKey } from "@/lib/roles/permissions";
import {
  START_TOUR_EVENT,
  boxAround,
  firstOnScreen,
  lightUp,
  readTourMemory,
  readTourParam,
  stopCountWords,
  tourPicks,
  tourStops,
  withoutTourParam,
  writeTourMemory,
  type Box,
  type TourAudience,
  type TourIcon,
  type TourPick,
  type TourStop,
} from "@/lib/ui/tour";
import { useAiFeature } from "./AiPanel";

type AppTourProps = {
  /** The pages on this person's rail, without the organization ("/compare"). */
  pages: readonly string[];
  /** Whether useUser has finished, so role and can are this person's own. */
  roleKnown: boolean;
  role: string;
  can: (key: PermissionKey) => boolean;
};

/** One tour from start to end: who it is for, and where it starts (null: the welcome card). */
type Session = { audience: TourAudience; startAt: number | null };

/** How long the logo animation may hold the welcome card back, at most. */
const INTRO_WAIT_MS = 8000;

export function AppTour({ pages, roleKnown, role, can }: AppTourProps) {
  const org = useOrg();
  const pathname = usePathname();
  const [arrived, setArrived] = useState<TourAudience | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [toastText, setToastText] = useState("");
  const [toastShown, setToastShown] = useState(false);

  // 1. Someone came in by one of the two doors (?tour=new or member).
  //    Take the word out of the address so a reload does not offer it again.
  useEffect(() => {
    const audience = readTourParam(window.location.search);
    if (!audience) return;
    const { pathname: path, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", path + withoutTourParam(search) + hash);
    // The address is only readable in the browser, after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArrived(audience);
  }, [pathname]);

  // 2. Offer it once the role is known (the words depend on it) and the logo
  //    animation has finished, unless this person finished or skipped it before.
  useEffect(() => {
    if (!arrived || !roleKnown || !org || session) return;
    if (readTourMemory(org.slug, role).done) {
      // What this browser remembers is only readable here, after the first render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setArrived(null);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      const introPlaying = document.documentElement.hasAttribute("data-intro");
      if (introPlaying && Date.now() - started < INTRO_WAIT_MS) return;
      window.clearInterval(timer);
      setArrived(null);
      setSession({ audience: arrived, startAt: null });
    }, 200);
    return () => window.clearInterval(timer);
  }, [arrived, roleKnown, org, role, session]);

  // 3. "Take the tour" from the account menu, or the command bar.
  //    It goes straight to the first card, or back to where it was closed.
  useEffect(() => {
    function onStart() {
      if (!org) return;
      const { resume } = readTourMemory(org.slug, role);
      setSession({ audience: "member", startAt: resume ?? 0 });
    }
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, [org, role]);

  useEffect(() => {
    if (!toastShown) return;
    const timer = window.setTimeout(() => setToastShown(false), 4200);
    return () => window.clearTimeout(timer);
  }, [toastShown, toastText]);

  const close = useCallback((message?: string) => {
    setSession(null);
    if (message) {
      setToastText(message);
      setToastShown(true);
      // Back to the account button, where the tour waits. After the page
      // behind stops being inert, which happens as the tour goes.
      window.setTimeout(() => document.querySelector<HTMLElement>(".who")?.focus(), 0);
    }
  }, []);

  return (
    <>
      {session && org && (
        <TourLayer
          key={`${session.audience}:${session.startAt}`}
          session={session}
          orgSlug={org.slug}
          pages={pages}
          role={role}
          orgName={org.name}
          can={can}
          onClose={close}
        />
      )}
      <div className={toastShown ? "toast show" : "toast"} role="status" aria-live="polite">
        {toastText}
      </div>
    </>
  );
}

type TourLayerProps = {
  session: Session;
  orgSlug: string;
  orgName: string;
  pages: readonly string[];
  role: string;
  can: (key: PermissionKey) => boolean;
  onClose: (message?: string) => void;
};

type Phase = "offer" | "touring" | "finish";

/** The five steps drawn across the top of the welcome card. */
const PATH: { icon: TourIcon; word: string }[] = [
  { icon: "connect", word: "Connect" },
  { icon: "compare", word: "Compare" },
  { icon: "script", word: "Script" },
  { icon: "ship", word: "Ship" },
  { icon: "watch", word: "Watch" },
];

/**
 * Everything on screen while a tour is up. Drawn only then, so the Ask AI
 * check (for the last stop's words) waits until someone takes the tour.
 */
function TourLayer({ session, orgSlug, orgName, pages, role, can, onClose }: TourLayerProps) {
  const { audience, startAt } = session;
  const orgPath = useOrgHref();
  const router = useRouter();
  const askAi = useAiFeature("schema-chat") === true;
  const stops = useMemo(() => tourStops({ audience, can, pages, askAi }), [audience, can, pages, askAi]);
  const picks = useMemo(() => tourPicks(audience, can, pages), [audience, can, pages]);
  const [phase, setPhase] = useState<Phase>(startAt === null ? "offer" : "touring");
  const [index, setIndex] = useState(() => Math.min(startAt ?? 0, stops.length - 1));
  const [showsEmpty, setShowsEmpty] = useState(false);
  const holeRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  const stop = stops[Math.min(index, stops.length - 1)];
  const last = index === stops.length - 1;

  function remember(resume: number | null) {
    writeTourMemory(orgSlug, role, { done: true, resume });
  }

  function begin() {
    setIndex(0);
    setPhase("touring");
  }

  function skip() {
    remember(null);
    onClose("No tour for now. It waits in your profile menu.");
  }

  function endEarly() {
    remember(index);
    onClose(`Tour closed at stop ${index + 1}. Pick it up from your profile menu.`);
  }

  function finish() {
    remember(null);
    if (pages.includes("/studio")) router.push(orgPath("/studio"));
    setPhase("finish");
  }

  function next() {
    if (last) finish();
    else setIndex(index + 1);
  }

  function back() {
    setIndex(Math.max(0, index - 1));
  }

  function choose(pick: TourPick) {
    onClose();
    if (pick.page === null) return;
    router.push(orgPath(pick.page));
  }

  // The page behind can't be clicked or tabbed into while the tour is up.
  useEffect(() => {
    const studio = document.querySelector(".studio");
    studio?.setAttribute("inert", "");
    return () => studio?.removeAttribute("inert");
  }, []);

  // Walk to the stop's page.
  useEffect(() => {
    if (phase !== "touring" || !stop.page) return;
    const target = orgPath(stop.page);
    if (window.location.pathname !== target) router.push(target);
  }, [phase, stop.page, orgPath, router]);

  // Light up the stop's part of the page, and keep up as the page loads,
  // scrolls or changes size.
  useEffect(() => {
    if (phase !== "touring") return;
    const expected = stop.page ? orgPath(stop.page) : null;
    // Where the page was last scrolled to for this stop. The page is scrolled
    // again only when that spot moves (the page loaded more, or the card
    // changed size), never while it is already on its way there.
    let aimed: number | null = null;
    function tick() {
      const hole = holeRef.current;
      const card = cardRef.current;
      if (!hole || !card) return;
      const onPage = expected === null || window.location.pathname === expected;
      // Still on the way to the page: leave the light where it is.
      if (!onPage) return;
      const found = findTarget(stop);
      // An empty page shows its first-run card, and the words change to match.
      setShowsEmpty(Boolean(stop.empty && found?.element.matches(stop.empty.target)));
      aimed = lightUp(hole, card, found?.element ?? null, found ? measure(stop, found.element) : null, aimed);
    }
    tick();
    const timer = window.setInterval(tick, 240);
    window.addEventListener("resize", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", tick);
    };
  }, [phase, stop, orgPath]);

  // Keyboard: arrows move, Escape leaves. Every other key except the ones that
  // work the buttons stops here, so the page's own shortcuts stay quiet.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === "Escape") {
        handled();
        if (phase === "offer") skip();
        else if (phase === "touring") endEarly();
        else onClose();
        return;
      }
      if (phase === "touring" && event.key === "ArrowRight") {
        handled();
        next();
        return;
      }
      if (phase === "touring" && event.key === "ArrowLeft") {
        handled();
        back();
        return;
      }
      if (event.key !== "Tab" && event.key !== "Enter" && event.key !== " ") event.stopPropagation();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  // Focus follows the tour: the main button of each card.
  useEffect(() => {
    const button = phase === "touring" ? nextRef.current : firstRef.current;
    button?.focus({ preventScroll: true });
  }, [phase, index]);

  if (phase === "offer") {
    const eyebrow =
      audience === "new" ? "Your workspace is ready" : `Welcome to ${orgName}`;
    // Each phase has its own key, so React builds fresh elements instead of
    // reusing the stops' ones, which still carry the light's inline size.
    return (
      <div className="tr-hi" key="offer">
        <div className="tr-hi-c" role="dialog" aria-modal="true" aria-labelledby="tour-offer-title">
          <ol className="tr-path" aria-hidden="true">
            {PATH.map((step, j) => (
              <li key={step.icon} style={{ "--d": j * 260 } as CSSProperties}>
                <i>
                  <TourGlyph icon={step.icon} size={18} />
                </i>
                {step.word}
              </li>
            ))}
          </ol>
          <span className="tr-eye">{eyebrow}</span>
          <h2 id="tour-offer-title">Want a quick look around?</h2>
          <p>
            {stopCountWords(stops.length)}, about a minute. The tour follows one change the whole way,
            from two schemas that differ to a script that has shipped. <b>Leave any time.</b>
          </p>
          <div className="tr-hi-r">
            <Button variant="primary" size="lg" ref={firstRef} onClick={begin}>
              Take the tour →
            </Button>
            <Button variant="ghost" onClick={skip}>
              Skip for now
            </Button>
          </div>
          <p className="tr-fine">If you skip, the tour waits in your profile menu, top right.</p>
        </div>
      </div>
    );
  }

  if (phase === "finish") {
    return (
      <div className="tr-hi" key="finish">
        <div className="tr-hi-c" role="dialog" aria-modal="true" aria-labelledby="tour-done-title">
          <div className="tr-ok" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 6.4l2.4 2.4 4.6-5.2" />
            </svg>
          </div>
          <h2 id="tour-done-title">That is the whole loop.</h2>
          <p>Connect, compare, script, ship, watch. Where do you want to start?</p>
          <div className="tr-pick">
            {picks.map((pick, j) => (
              <button key={pick.id} type="button" ref={j === 0 ? firstRef : undefined} onClick={() => choose(pick)}>
                <b>{pick.title}</b>
                <small>{pick.hint}</small>
                <span aria-hidden="true">→</span>
              </button>
            ))}
          </div>
          <p className="tr-fine">
            You can take the tour again any time from your profile menu.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="tour" key="stops">
      <div className="tr-hole" ref={holeRef} aria-hidden="true" />
      <div className="tr-card" ref={cardRef} role="dialog" aria-modal="true" aria-labelledby="tour-stop-title">
        <div className="tr-prog" aria-hidden="true">
          {stops.map((each, j) => (
            <i key={each.id} className={j < index ? "d" : j === index ? "on" : undefined} />
          ))}
        </div>
        <div aria-live="polite">
          <div className="tr-in in" key={stop.id}>
            <div className="tr-k">
              <i aria-hidden="true">
                <TourGlyph icon={stop.icon} size={16} />
              </i>
              {stop.kicker}
              <em>
                {index + 1} of {stops.length}
              </em>
            </div>
            <h2 id="tour-stop-title">{stop.title}</h2>
            <p>{showsEmpty && stop.empty ? stop.empty.body : stop.body}</p>
          </div>
        </div>
        <div className="tr-f">
          <button type="button" className="tr-skip" onClick={endEarly}>
            End tour
          </button>
          {index > 0 && (
            <Button variant="ghost" onClick={back}>
              Back
            </Button>
          )}
          <Button variant="primary" ref={nextRef} onClick={next}>
            {last ? "Finish" : "Next"}
          </Button>
        </div>
        <p className="tr-keys">
          <kbd>←</kbd> <kbd>→</kbd> to move, <kbd>Esc</kbd> to leave
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- finding

/** The first thing on screen the stop names, or the page's heading when none is. */
function findTarget(stop: TourStop): { element: Element } | null {
  for (const selector of stop.targets) {
    const element = firstOnScreen(selector);
    if (element) return { element };
  }
  if (stop.page === null) return null;
  const heading = firstOnScreen(".page-header");
  return heading ? { element: heading } : null;
}

/** The box to light up: the target, or with `union` every target together. */
function measure(stop: TourStop, first: Element): Box {
  const elements = stop.union
    ? stop.targets.map(firstOnScreen).filter((element): element is Element => element !== null)
    : [first];
  return boxAround(elements);
}

// ---------------------------------------------------------------- the drawings

const GLYPHS: Record<TourIcon, ReactNode> = {
  home: (
    <>
      <path d="M2.5 7.5 8 3l5.5 4.5V13h-11z" />
      <path d="M6.5 13V9.5h3V13" />
    </>
  ),
  connect: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </>
  ),
  compare: (
    <>
      <rect x="2" y="3" width="4.5" height="10" rx="1.2" />
      <rect x="9.5" y="3" width="4.5" height="10" rx="1.2" />
    </>
  ),
  script: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />,
  ship: <path d="M8 10.5v-8M4.8 5.5 8 2.5l3.2 3M2.5 10.5v3h11v-3" />,
  sync: (
    <>
      <path d="M13 5.5A5.5 5.5 0 0 0 3.2 4.6M3 10.5a5.5 5.5 0 0 0 9.8.9" />
      <path d="M3 2v3h3M13 14v-3h-3" />
    </>
  ),
  watch: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  ask: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.4 6.3a1.7 1.7 0 1 1 2.4 1.6c-.5.3-.8.6-.8 1.2M8 11.4v.1" />
    </>
  ),
};

function TourGlyph({ icon, size }: { icon: TourIcon; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[icon]}
    </svg>
  );
}
