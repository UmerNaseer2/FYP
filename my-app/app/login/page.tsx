"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useTheme } from "@/hooks/useTheme";
import { APP_VERSION } from "@/lib/app-version";
import { safeCallbackUrl, wantsAccountPicker } from "@/lib/callback-url";
import { resetIntro } from "@/lib/intro";
import { SunIcon, MoonIcon, LockIcon, AlertCircleIcon, ChevronLeftIcon } from "@/components/ui/icons";
import { BrandMark } from "@/components/ui/BrandMark";
import "../styles/atelier-signin.css";

/** "redirecting" is the sign-in on its way to Microsoft or GitHub. */
type Status = "idle" | "redirecting" | "error";

/** The two ways to sign in. */
type Via = "microsoft" | "github";

/** The ways this server offers, once it has said. */
type Offered = Record<Via, boolean>;

/** The provider IDs in auth.config.ts that a browser sign-in goes through. */
const BROWSER_PROVIDER: Record<Via, string> = {
  microsoft: "microsoft-entra-id",
  github: "github",
};

const VIA_NAME: Record<Via, string> = { microsoft: "Microsoft", github: "GitHub" };

/**
 * What the browser is asked to share, shown while it is on its way. GitHub's
 * are the scopes Auth.js asks for by default, which auth.config.ts keeps.
 */
const VIA_SCOPES: Record<Via, string> = {
  microsoft: "openid · profile · email",
  github: "read:user · user:email",
};

/**
 * NextAuth reports a failed sign-in by bouncing the browser back to
 * /login?error=<code>. The page used to ignore that parameter completely, so a
 * failure looked like a button that did nothing. These are the codes NextAuth
 * can send, written out in plain words.
 *
 * The next four are the app's own, sent by the signIn callback in auth.ts when
 * it turns a sign-in away: the account shared no address (NoEmail), its
 * address belongs to a person who signs in another way (AccountExists), the
 * provider has not confirmed the address is theirs (EmailUnverified), or the
 * database could not be asked (AccountUnavailable). Each says what to do next,
 * because none of them is fixed by pressing the same button again.
 */
const ERROR_MESSAGES: Record<string, string> = {
  Configuration: "Sign-in is not set up on this server yet.",
  AccessDenied: "That account is not allowed to use Schema Studio.",
  Verification: "That sign-in link has expired. Start again.",
  OAuthSignin: "Could not start the sign-in. Try again in a moment.",
  OAuthCallback: "The sign-in came back incomplete. Try again.",
  OAuthAccountNotLinked: "That email already signed in a different way.",
  SessionRequired: "Sign in to continue.",
  NoEmail:
    "That account did not share an email address, and Schema Studio needs one. Add one to the account, or use another.",
  AccountExists:
    "That email address belongs to someone here who signs in another way. Sign in the way you did before.",
  EmailUnverified:
    "That account has not confirmed its email address is yours. Confirm it with Microsoft or GitHub, or use another account.",
  AccountUnavailable: "Schema Studio could not finish signing you in. Try again in a moment.",
};

function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? "Sign-in failed or was cancelled.";
}

/** Small 2×2 Microsoft brand mark used on the SSO button. */
function MsMark() {
  return (
    <span className="ms-mark" aria-hidden="true">
      <span className="a" />
      <span className="b" />
      <span className="c" />
      <span className="d" />
    </span>
  );
}

/** GitHub's mark (Primer's mark-github octicon), in the button's text color. */
function GitHubMark() {
  return (
    <svg className="gh-mark" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
      />
    </svg>
  );
}

function ViaMark({ via }: { via: Via }) {
  return via === "github" ? <GitHubMark /> : <MsMark />;
}

/** The ways offered, in the order the page shows them. */
function offeredVias(offered: Offered | null): Via[] {
  if (!offered) return [];
  return (["microsoft", "github"] as const).filter((via) => offered[via]);
}

export default function LoginPage() {
  const { theme, toggleTheme } = useTheme();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** The raw wording behind an error, shown only under "Technical details". */
  const [errorTech, setErrorTech] = useState<string | null>(null);
  /** Whether "Trouble signing in?" is showing its help. */
  const [helpOpen, setHelpOpen] = useState(false);
  /** null while we are still asking the server which providers it has. */
  const [offered, setOffered] = useState<Offered | null>(null);
  /** The way the person picked, for the "on its way" wording. */
  const [via, setVia] = useState<Via>("microsoft");
  const vias = offeredVias(offered);
  const ssoReady = offered === null ? null : vias.length > 0;

  // One pass on load: ask NextAuth what it can offer, and pick up the error
  // code a failed sign-in leaves in the URL. Both settle in the same render so
  // the card never flashes one banner and then swaps to another.
  //
  // Each way to sign in has its button only when the server has its keys, and
  // with none of them the provider list comes back empty: a button that can
  // only fail is worse than saying plainly that sign-in is not set up.
  // window.location is read instead of useSearchParams so this page can stay
  // statically rendered.
  useEffect(() => {
    let cancelled = false;

    async function loadSignInState() {
      const code = new URLSearchParams(window.location.search).get("error");

      let next: Offered = { microsoft: false, github: false };
      try {
        const res = await fetch("/api/auth/providers");
        const providers: Record<string, unknown> = res.ok ? await res.json() : {};
        next = {
          microsoft: Boolean(providers[BROWSER_PROVIDER.microsoft]),
          github: Boolean(providers[BROWSER_PROVIDER.github]),
        };
      } catch {
        // Unreadable counts as none: see the test of the same name.
      }

      if (cancelled) return;
      setOffered(next);
      if (code) {
        setErrorMsg(errorMessage(code));
        setStatus("error");
      }
    }

    loadSignInState();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(chosen: Via) {
    setErrorMsg(null);
    setErrorTech(null);
    // Signing in plays the logo reveal again when the studio opens.
    resetIntro();
    const callbackUrl = safeCallbackUrl(window.location.search, window.location.origin);
    try {
      setVia(chosen);
      setStatus("redirecting");
      // Microsoft and GitHub both sign straight back in to the account the
      // browser last used, without asking. That is right for a normal
      // sign-in, but not for someone who signed out to use another account,
      // so for them both are asked to show their account picker instead.
      if (wantsAccountPicker(window.location.search)) {
        await signIn(BROWSER_PROVIDER[chosen], { callbackUrl }, { prompt: "select_account" });
      } else {
        await signIn(BROWSER_PROVIDER[chosen], { callbackUrl });
      }
    } catch (error: unknown) {
      // The error's own wording is written for developers, so it goes under
      // "Technical details" and the headline says what to do.
      console.error(error);
      setErrorMsg("Could not start the sign-in. Try again in a moment.");
      setErrorTech(error instanceof Error ? error.message : null);
      setStatus("error");
    }
  }

  /** The button look: the first way is the dark pill, any other is outlined. */
  const buttonClass = (index: number) => (index === 0 ? "si-ms" : "si-ms si-alt");

  return (
    <div className="si-page">
      <div className="si">
        {/* Left: what the product is, drawn rather than told. */}
        <section className="si-art" aria-labelledby="si-tagline">
          <svg className="si-sq" viewBox="0 0 300 300" aria-hidden="true">
            <rect x="40" y="40" width="150" height="150" rx="36" fill="var(--accent)" />
            <rect
              x="110"
              y="110"
              width="150"
              height="150"
              rx="36"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            />
          </svg>
          <div className="brand">
            <BrandMark size={30} />
            <span className="brand-name">Schema Studio</span>
            <span className="brand-v mono">v{APP_VERSION}</span>
          </div>
          <h2 id="si-tagline">Version control for your database schema.</h2>
          {/* A picture of a review, not data: three made-up changes. */}
          <ul aria-hidden="true">
            <li>
              <i className="g add">+</i>reviews<code>new table</code>
            </li>
            <li>
              <i className="g chg">~</i>customers.phone<code>varchar(32)</code>
            </li>
            <li>
              <i className="g rem">−</i>orders_customer_idx<code>index dropped</code>
            </li>
          </ul>
        </section>

        {/* Right: the sign-in card. */}
        <main className="si-main">
          {/* Back to the front page. */}
          <Link className="btn btn-ghost btn-sm si-back" href="/">
            <ChevronLeftIcon size={14} />
            <span>Back</span>
          </Link>
          <div className="si-top">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={toggleTheme}
              title="Toggle theme"
            >
              {theme === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
          </div>

          <article className="card si-card">
            <h1>Welcome to Schema Studio</h1>
            <p className="sub">
              Sign in with the account your team uses. There is no separate password to remember.
            </p>

            {/* state-swappable region: `key` remounts it so the fade replays */}
            <div className="swap" key={ssoReady === false ? "unconfigured" : status}>
              {ssoReady === false && (
                // Nothing to sign in against. The greyed out button never
                // stands alone: the note under it says why and what to do
                // next. Setting names stay under "Technical details", for
                // whoever runs the server.
                <div>
                  <button
                    type="button"
                    className="si-ms"
                    disabled
                    aria-label="Continue with Microsoft (unavailable)"
                  >
                    <MsMark />
                    <span>Continue with Microsoft</span>
                  </button>
                  <div className="notice notice--warn si-notice" role="alert">
                    <span className="notice__icon" aria-hidden="true">
                      <AlertCircleIcon size={18} />
                    </span>
                    <div className="notice__main">
                      <p className="notice__title">
                        Sign-in isn&apos;t set up on this server yet.
                      </p>
                      <p className="notice__body">
                        Nothing is wrong with your account. Whoever runs this server needs to finish setting up sign-in.
                      </p>
                      <details className="notice__tech">
                        <summary>Technical details</summary>
                          <p>
                            This server has no sign-in credentials. Set
                            NEXTAUTH_SECRET to a random value of its own (the
                            example in docker-compose.yml does not count),
                            plus AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET
                            and AZURE_AD_TENANT_ID for Microsoft or
                            GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET for
                            GitHub, then restart.
                          </p>
                      </details>
                    </div>
                  </div>
                </div>
              )}

              {ssoReady === null && status === "idle" && (
                // Only while the server says which ways it offers, which is
                // quick; a guessed button could be one it does not have.
                <button type="button" className="si-ms busy" disabled aria-busy="true">
                  <span className="spin" aria-hidden="true" />
                  <span>Loading sign-in…</span>
                </button>
              )}

              {ssoReady === true && status === "idle" && (
                <div>
                  <div className="si-ways">
                    {vias.map((way, index) => (
                      <button
                        key={way}
                        type="button"
                        className={buttonClass(index)}
                        onClick={() => handleLogin(way)}
                        aria-label={`Continue with ${VIA_NAME[way]}`}
                      >
                        <ViaMark via={way} />
                        <span>Continue with {VIA_NAME[way]}</span>
                      </button>
                    ))}
                  </div>
                  <p className="si-note">
                    {`You'll sign in with ${vias.map((way) => VIA_NAME[way]).join(" or ")}, then come straight back here.`}
                  </p>
                </div>
              )}

              {ssoReady !== false && status === "redirecting" && (
                <div>
                  <button type="button" className="si-ms busy" disabled aria-busy="true">
                    <span className="spin" aria-hidden="true" />
                    <span>Redirecting to {VIA_NAME[via]}…</span>
                  </button>
                  <p className="si-note mono">{VIA_SCOPES[via]}</p>
                </div>
              )}

              {ssoReady !== false && status === "error" && (
                <div>
                  <div className="notice si-notice si-notice--first" role="alert">
                    <span className="notice__icon" aria-hidden="true">
                      <AlertCircleIcon size={18} />
                    </span>
                    <div className="notice__main">
                      <p className="notice__title">
                        {errorMsg ?? "Sign-in failed or was cancelled."}
                      </p>
                      <p className="notice__body">
                        Try again. If it keeps happening, ask whoever runs this server.
                      </p>
                      {errorTech && (
                        <details className="notice__tech">
                          <summary>Technical details</summary>
                          <p>{errorTech}</p>
                        </details>
                      )}
                    </div>
                  </div>
                  <div className="si-ways">
                    {vias.map((way, index) => (
                      <button
                        key={way}
                        type="button"
                        className={buttonClass(index)}
                        onClick={() => handleLogin(way)}
                        aria-label={`Retry with ${VIA_NAME[way]}`}
                      >
                        <ViaMark via={way} />
                        <span>Retry with {VIA_NAME[way]}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <p className="si-sm">
              Schema Studio reads your name and email from the account you sign in with and nothing
              else. What you may do here is decided by your organization&apos;s admins.
            </p>

            {/* inline help */}
            <div className="si-foot">
              <span className="si-lock">
                <LockIcon size={13} /> Encrypted in transit · single sign-on
              </span>
              <button
                type="button"
                className="flink"
                aria-expanded={helpOpen}
                aria-controls="signin-help"
                onClick={() => setHelpOpen((open) => !open)}
              >
                Trouble signing in?
              </button>
            </div>
            <p id="signin-help" className="si-help" hidden={!helpOpen}>
              {"If someone invited you, sign in with an account that uses the email address " +
                  "the invitation went to, then open the invitation link again. Otherwise, sign " +
                  "in to make an organization of your own. Inside an organization, its admins " +
                  "choose what you can do. If the sign-in turns you away, ask whoever runs this " +
                  "server which accounts it accepts."}
            </p>
          </article>

          <Link className="flink si-what" href="/">
            What is Schema Studio?
          </Link>
        </main>
      </div>
    </div>
  );
}
