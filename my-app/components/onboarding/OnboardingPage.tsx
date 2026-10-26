"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LandingThemeToggle } from "@/components/landing/LandingThemeToggle";
import {
  AlertCircleIcon,
  ChevronRightIcon,
  LogoIcon,
  PlusIcon,
  RefreshIcon,
  SignOutIcon,
} from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";
import { cleanOrgName, orgNameProblem, orgSlugProblem, suggestSlug } from "@/lib/new-organization";
import { isOrgListing, type OrgSummary } from "@/lib/organization-list";
import { signOutEverywhere } from "@/lib/sign-out";

/** The list, while it loads and once it has. */
type Loaded =
  | { state: "loading" }
  | { state: "ready"; organizations: OrgSummary[]; canCreate: boolean }
  | Failed;

/**
 * Something the server turned down or never answered. `signedOut` is a 401:
 * the session has ended, or its profile is gone, so trying again cannot help
 * and signing in again can.
 */
type Failed = { state: "failed"; message: string; signedOut: boolean };

/** What POST /api/organizations did with the form. */
type Made =
  | { ok: true }
  | { ok: false; field: "name" | "slug" | null; message: string; signedOut: boolean };

/** Where a 401 sends someone: sign in, then straight back to this page. */
const SIGN_IN_AGAIN = "/login?callbackUrl=/onboarding";

const UNREACHABLE = "Could not reach the server. Check your connection, then try again.";

/** The `error` a route sent with a refusal, or null when it sent none. */
function errorFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { error } = body as { error?: unknown };
  return typeof error === "string" && error !== "" ? error : null;
}

/** A response's JSON, or null when it has none: a proxy's HTML page, say. */
async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function readOrganizations(): Promise<Exclude<Loaded, { state: "loading" }>> {
  let response: Response;
  try {
    response = await apiFetch("/api/organizations");
  } catch {
    return { state: "failed", message: UNREACHABLE, signedOut: false };
  }
  const body = await jsonOf(response);
  if (!response.ok) {
    return {
      state: "failed",
      message: errorFrom(body) ?? `Could not read your organizations (HTTP ${response.status}).`,
      signedOut: response.status === 401,
    };
  }
  if (!isOrgListing(body)) {
    return {
      state: "failed",
      message: "The server's answer could not be read. Try again in a moment.",
      signedOut: false,
    };
  }
  return { state: "ready", organizations: body.organizations, canCreate: body.canCreate };
}

async function postOrganization(name: string, slug: string): Promise<Made> {
  let response: Response;
  try {
    response = await apiFetch("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, slug }),
    });
  } catch {
    return { ok: false, field: null, message: UNREACHABLE, signedOut: false };
  }
  if (response.status === 201) return { ok: true };
  const body = await jsonOf(response);
  const field = (body as { field?: unknown } | null)?.field;
  return {
    ok: false,
    field: field === "name" || field === "slug" ? field : null,
    message: errorFrom(body) ?? `Could not create the organization (HTTP ${response.status}).`,
    signedOut: response.status === 401,
  };
}

/**
 * "Your organizations": the client side of app/onboarding/page.tsx, which says
 * who is sent here and why.
 *
 * It lists the organizations the person belongs to, each a link into its
 * studio, and offers a form to create a new one when the server says it would
 * allow it (`canCreate`). Someone who creates one becomes its Admin and is
 * taken straight into it.
 *
 * The form checks the name and the address with the same rules the route
 * uses (lib/new-organization.ts), so most mistakes are caught before anything
 * is sent, in the same words the route would use. The route still has the
 * last say: an address someone else took a moment ago is only found out
 * there, and its answer names the field, so it lands under the right box.
 *
 * `demo` is the bypass, where nobody is signed in. Then there is no Sign out,
 * and the server lists every organization and offers no form.
 */
export function OnboardingPage({ demo }: { demo: boolean }) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  /** Bumped by "Try again", which reads the list once more. */
  const [attempt, setAttempt] = useState(0);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  /**
   * Whether the address is the person's own. Until it is, it follows the
   * name, which is what most people want. Emptying the box hands it back to
   * the name, which fills it again the next time it changes. It is not filled
   * on the spot: someone clearing the box to type a new address would have
   * it typed over.
   */
  const [slugEdited, setSlugEdited] = useState(false);
  /** Whether the person has been in the address box and left it. */
  const [slugLeft, setSlugLeft] = useState(false);
  /** Whether Create has been pressed, after which every problem shows. */
  const [attempted, setAttempted] = useState(false);
  /** "creating" while the server works, "opening" once it has and the studio loads. */
  const [submitting, setSubmitting] = useState<"creating" | "opening" | null>(null);
  /** The route's refusal of the last try, until the box it is about changes. */
  const [refusal, setRefusal] = useState<Extract<Made, { ok: false }> | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const slugInput = useRef<HTMLInputElement>(null);

  // Each state is set only once the answer is in, so a slow answer to an
  // earlier attempt can never land on top of a later one.
  useEffect(() => {
    let cancelled = false;
    readOrganizations().then((next) => {
      if (!cancelled) setLoaded(next);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function tryAgain() {
    setLoaded({ state: "loading" });
    setAttempt((count) => count + 1);
  }

  const cleanName = cleanOrgName(name);
  const trimmedSlug = slug.trim();
  const nameRule = orgNameProblem(cleanName);
  const slugRule = orgSlugProblem(trimmedSlug);

  // A name's problems show as soon as there is a name, because none of them
  // can come from a name that is only half typed. An address's can ("ac" is
  // too short on the way to "acme"), so they wait until the person leaves the
  // box or presses Create.
  const nameProblem =
    refusal?.field === "name" ? refusal.message : attempted || name !== "" ? nameRule : null;
  const slugProblem =
    refusal?.field === "slug" ? refusal.message : attempted || slugLeft ? slugRule : null;
  const banner = refusal && refusal.field === null ? refusal : null;

  function changeName(value: string) {
    setName(value);
    if (refusal?.field === "name") setRefusal(null);
    if (!slugEdited) {
      setSlug(suggestSlug(value));
      if (refusal?.field === "slug") setRefusal(null);
    }
  }

  function changeSlug(value: string) {
    // An address is lowercase, so a capital typed in it is taken to mean the
    // lowercase letter rather than turned down.
    setSlug(value.toLowerCase());
    setSlugEdited(value !== "");
    if (refusal?.field === "slug") setRefusal(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setAttempted(true);
    setRefusal(null);
    if (nameRule) {
      nameInput.current?.focus();
      return;
    }
    if (slugRule) {
      slugInput.current?.focus();
      return;
    }

    setSubmitting("creating");
    const made = await postOrganization(cleanName, trimmedSlug);
    if (made.ok) {
      // The route stored exactly the address that was sent, so the page goes
      // there without needing to trust anything in the answer. The button
      // stays busy until the studio replaces this page.
      setSubmitting("opening");
      router.push(`/${trimmedSlug}/studio`);
      return;
    }
    setSubmitting(null);
    setRefusal(made);
    // The boxes are read-only while a request is out rather than disabled,
    // because a disabled box cannot take focus and this runs before React has
    // drawn them editable again.
    if (made.field === "name") nameInput.current?.focus();
    if (made.field === "slug") slugInput.current?.focus();
  }

  return (
    <div className="auth-stage">
      <div className="bg-grid" aria-hidden="true" />
      <div className="bg-wash-a" aria-hidden="true" />
      <div className="bg-wash-b" aria-hidden="true" />

      <header className="onb-header relative z-10 px-8 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-lg grid place-items-center text-white"
            style={{ background: "var(--brand)" }}
          >
            <LogoIcon size={15} />
          </div>
          <div className="onb-brand-name font-semibold text-[13.5px]">Schema Studio</div>
        </div>
        <div className="flex items-center gap-2">
          <LandingThemeToggle />
          {!demo && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void signOutEverywhere()}
            >
              <SignOutIcon size={14} />
              <span>Sign out</span>
            </button>
          )}
        </div>
      </header>

      <main className="relative z-10 flex-1 grid place-items-center px-6 pb-10 pt-2">
        <div className="w-full max-w-[440px]">
          <article className="auth-card p-8">
            <div className="flex flex-col items-center text-center">
              <div
                className="w-12 h-12 rounded-2xl grid place-items-center mb-4 text-white"
                style={{
                  background: "var(--brand)",
                  boxShadow: "0 8px 24px -10px var(--brand), 0 0 0 6px var(--brand-soft)",
                }}
              >
                <LogoIcon size={22} />
              </div>
              <h1 className="text-[24px] font-semibold tracking-[-0.015em]">Your organizations</h1>
              <p className="text-[13.5px] mt-1.5" style={{ color: "var(--text-2)" }}>
                {demo
                  ? "Sign-in is switched off here, so these are the demo's organizations."
                  : "Open one you belong to, or create a new one for your team."}
              </p>
            </div>

            <Divider label="Member of" />

            {loaded.state === "loading" && (
              <div className="onb-loading" role="status">
                <span className="spin" aria-hidden="true" />
                <span>Loading your organizations…</span>
              </div>
            )}

            {loaded.state === "failed" && (
              <div className="flex flex-col items-start gap-3">
                <div className="banner w-full" role="alert">
                  <AlertCircleIcon size={16} className="ico" />
                  <div className="body">
                    <div className="title">{loaded.message}</div>
                  </div>
                </div>
                {loaded.signedOut ? (
                  <Link className="btn btn-primary btn-sm" href={SIGN_IN_AGAIN}>
                    Sign in
                  </Link>
                ) : (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={tryAgain}>
                    <RefreshIcon size={14} />
                    <span>Try again</span>
                  </button>
                )}
              </div>
            )}

            {loaded.state === "ready" && loaded.organizations.length === 0 && (
              <div className="text-[13px]">
                <p>You are not in any organization yet.</p>
                <p className="help mt-1">
                  If someone has asked you to join theirs, open the invitation link they sent you.
                  {loaded.canCreate && " Or create your own below."}
                </p>
              </div>
            )}

            {loaded.state === "ready" && loaded.organizations.length > 0 && (
              <ul className="onb-orgs">
                {loaded.organizations.map((org) => (
                  <li key={org.slug}>
                    <Link className="onb-org" href={`/${org.slug}/studio`}>
                      <span className="mark" aria-hidden="true">
                        {initialOf(org.name)}
                      </span>
                      <span className="text">
                        <span className="name">{org.name}</span>
                        <span className="slug">/{org.slug}</span>
                      </span>
                      <ChevronRightIcon size={14} className="chev" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {loaded.state === "ready" && loaded.canCreate && (
              <>
                <Divider label="New organization" />
                <form className="onb-form" onSubmit={handleSubmit} noValidate>
                  <div className="onb-field">
                    <label className="label" htmlFor="org-name">
                      Name
                    </label>
                    <input
                      ref={nameInput}
                      id="org-name"
                      className="input"
                      value={name}
                      onChange={(event) => changeName(event.target.value)}
                      readOnly={submitting !== null}
                      autoComplete="organization"
                      placeholder="Acme Data Team"
                      aria-invalid={nameProblem ? true : undefined}
                      aria-describedby={nameProblem ? "org-name-problem" : undefined}
                    />
                    {nameProblem && (
                      <p id="org-name-problem" className="field-problem">
                        {nameProblem}
                      </p>
                    )}
                  </div>

                  <div className="onb-field">
                    <label className="label" htmlFor="org-slug">
                      Address
                    </label>
                    <input
                      ref={slugInput}
                      id="org-slug"
                      className="input mono"
                      value={slug}
                      onChange={(event) => changeSlug(event.target.value)}
                      onBlur={() => setSlugLeft(true)}
                      readOnly={submitting !== null}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="acme-data-team"
                      aria-invalid={slugProblem ? true : undefined}
                      aria-describedby={
                        slugProblem ? "org-slug-help org-slug-problem" : "org-slug-help"
                      }
                    />
                    <p id="org-slug-help" className="help">
                      Its pages open at{" "}
                      <span className="mono">/{trimmedSlug || "your-address"}/studio</span>
                    </p>
                    {slugProblem && (
                      <p id="org-slug-problem" className="field-problem">
                        {slugProblem}
                      </p>
                    )}
                  </div>

                  {banner && (
                    <div className="banner" role="alert">
                      <AlertCircleIcon size={16} className="ico" />
                      <div className="body">
                        <div className="title">{banner.message}</div>
                        {banner.signedOut && (
                          <Link className="flink" href={SIGN_IN_AGAIN}>
                            Sign in again
                          </Link>
                        )}
                      </div>
                    </div>
                  )}

                  <button
                    type="submit"
                    className="btn btn-primary w-full"
                    disabled={submitting !== null}
                    aria-busy={submitting !== null || undefined}
                  >
                    {submitting ? (
                      <>
                        <span className="spin" aria-hidden="true" />
                        <span>{submitting === "creating" ? "Creating…" : "Opening…"}</span>
                      </>
                    ) : (
                      <>
                        <PlusIcon size={14} />
                        <span>Create organization</span>
                      </>
                    )}
                  </button>
                  <p className="help text-center">You will be its Admin, and can invite others from it.</p>
                </form>
              </>
            )}

            {loaded.state === "ready" && !loaded.canCreate && (
              <p className="help mt-6 text-center">
                {demo
                  ? "Creating an organization needs a real sign-in, so there is no one here to be its first Admin."
                  : "This server does not create new organizations."}
              </p>
            )}
          </article>
        </div>
      </main>
    </div>
  );
}

/** A thin rule with a small uppercase label in the middle, as on the sign-in card. */
function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-6">
      <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
      <span
        className="text-[11px]"
        style={{ color: "var(--text-3)", letterSpacing: ".06em", textTransform: "uppercase" }}
      >
        {label}
      </span>
      <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
    </div>
  );
}

/** The first character of a name, for the square beside it. Array.from keeps a whole emoji. */
function initialOf(name: string): string {
  return (Array.from(name)[0] ?? "?").toUpperCase();
}
