"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useTheme } from "@/hooks/useTheme";
import { useDesktopBridge } from "@/hooks/useDesktopBridge";
import {
  getDesktopBridge,
  type DesktopBridge,
  type DesktopSignInResult,
} from "@/lib/desktop-bridge";
import { safeCallbackUrl } from "@/lib/callback-url";
import {
  LogoIcon,
  SunIcon,
  MoonIcon,
  ChevronRightIcon,
  RefreshIcon,
  LockIcon,
  AlertCircleIcon,
} from "@/components/ui/icons";

/**
 * "redirecting" is the browser sign-in, on its way to Microsoft. The desktop
 * app's sign-in has two steps of its own instead: "waiting" while the person
 * signs in in their web browser, and "finishing" while this server checks the
 * ID token the app got back.
 */
type Status = "idle" | "redirecting" | "waiting" | "finishing" | "error";

/** The two ways to sign in. Inside the desktop app only Microsoft is offered. */
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
 *
 * The last three only ever come from the desktop app. CredentialsSignin is what
 * NextAuth sends when lib/desktop-sign-in.ts refuses the app's ID token, and
 * the app itself signs a person out and sends them here with SessionRevoked
 * (Microsoft no longer accepts their sign-in) or OfflineTooLong (the computer
 * went 30 days without being able to ask).
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
  CredentialsSignin: "Schema Studio could not confirm your Microsoft sign-in.",
  SessionRevoked: "Your Microsoft sign-in has ended. Sign in again to carry on.",
  OfflineTooLong:
    "This computer has been offline for more than 30 days, so you need to sign in again.",
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
  /** The desktop app's bridge, or null in a browser. Only the wording uses it. */
  const desktop = useDesktopBridge();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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
        // Inside the desktop app the server offers the app's own "desktop"
        // provider instead of the browser ones (see auth.config.ts), and the
        // browser ones would take the app's own window off to Microsoft or
        // GitHub, which the app is built never to do. So there only that one
        // counts, and it is a Microsoft sign-in.
        next = getDesktopBridge()
          ? { microsoft: Boolean(providers.desktop), github: false }
          : {
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

  /**
   * The desktop app's sign-in. The app opens the system browser on Microsoft's
   * page and hands back the ID token Microsoft gave it; this posts that token
   * to the "desktop" provider in auth.config.ts, which checks it.
   *
   * Like the browser sign-in, the last step navigates by itself: to
   * `callbackUrl` when the token is accepted, or back here with
   * ?error=CredentialsSignin when it is not, which the effect above then puts
   * into words.
   */
  async function desktopSignIn(bridge: DesktopBridge, callbackUrl: string) {
    setStatus("waiting");
    let result: DesktopSignInResult;
    try {
      result = await bridge.signIn();
    } catch (error) {
      // The app answers every sign-in with a result, failures included, so
      // this only happens when something in the app itself broke. What arrives
      // then is wrapped in Electron's wording, which would mean nothing to the
      // person reading it; the details are in the app's log.
      console.error(error);
      result = {
        ok: false,
        reason: "failed",
        message:
          "Schema Studio could not start the sign-in. Try again, or open the app's log from Help > Open Logs.",
      };
    }
    if (!result.ok) {
      // Cancelling is the person changing their mind, not a failure, so it
      // goes quietly back to the button.
      if (result.reason === "cancelled") {
        setStatus("idle");
      } else {
        setErrorMsg(result.message);
        setStatus("error");
      }
      return;
    }
    setStatus("finishing");
    await signIn("desktop", { idToken: result.idToken, callbackUrl });
  }

  async function handleLogin(chosen: Via) {
    setErrorMsg(null);
    const callbackUrl = safeCallbackUrl(window.location.search, window.location.origin);
    try {
      const bridge = getDesktopBridge();
      if (bridge) {
        await desktopSignIn(bridge, callbackUrl);
        return;
      }
      setVia(chosen);
      setStatus("redirecting");
      await signIn(BROWSER_PROVIDER[chosen], { callbackUrl });
    } catch (error: unknown) {
      console.error(error);
      setErrorMsg(error instanceof Error ? error.message : "Sign-in failed.");
      setStatus("error");
    }
  }

  return (
    <div className="auth-stage">
      {/* ——— decorative background ——— */}
      <div className="bg-grid" aria-hidden="true" />
      <div className="bg-wash-a" aria-hidden="true" />
      <div className="bg-wash-b" aria-hidden="true" />
      <div className="deco" aria-hidden="true" style={{ top: "18%", left: "8%" }}>
        finance<span style={{ color: "var(--text-3)" }}>@</span>Prod — RDS{" "}
        <span className="mono">v2.3.0 · 0007</span>
      </div>
      <div className="deco" aria-hidden="true" style={{ top: "30%", left: "6%" }}>
        <span className="add">+ invoice_lines.id uuid PRIMARY KEY</span>
      </div>
      <div className="deco" aria-hidden="true" style={{ top: "34%", left: "6%" }}>
        <span className="chg">~ amount numeric(10,2) → numeric(12,2)</span>
      </div>
      <div className="deco" aria-hidden="true" style={{ bottom: "22%", right: "7%" }}>
        CREATE INDEX invoice_lines_invoice_id_idx
      </div>
      <div className="deco" aria-hidden="true" style={{ bottom: "18%", right: "7%" }}>
        <span className="add">+ ALTER TABLE invoices ALTER COLUMN amount …</span>
      </div>
      <div className="deco" aria-hidden="true" style={{ top: "14%", right: "9%" }}>
        analytics<span style={{ color: "var(--text-3)" }}>@</span>Staging — Neon{" "}
        <span className="mono">v0.9.0 · 0003</span>
      </div>

      {/* ——— top bar: brand + theme toggle ——— */}
      <header className="relative z-10 px-8 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-lg grid place-items-center text-white"
            style={{ background: "var(--brand)" }}
          >
            <LogoIcon size={15} />
          </div>
          <div className="leading-tight">
            <div className="font-semibold text-[13.5px]">Schema Studio</div>
            <div className="text-[11px] mono" style={{ color: "var(--text-3)" }}>
              v2.0.0
            </div>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={toggleTheme}
          title="Toggle theme"
        >
          {theme === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
          <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>
      </header>

      {/* ——— login card ——— */}
      <main className="relative z-10 flex-1 grid place-items-center px-6 pb-10 pt-2">
        <div className="w-full max-w-[420px] relative">
          {/* top labels */}
          <div className="flex items-center gap-2 justify-center mb-5">
            <span className="pill pill-brand">
              <span className="dot" />
              Single sign-on
            </span>
            <span className="pill pill-neutral">
              <span className="dot" style={{ background: "var(--text-3)" }} />
              <span className="mono">v2.0.0</span>
            </span>
          </div>

          <article className="auth-card p-8">
            {/* brand block */}
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
              <h1 className="text-[24px] font-semibold tracking-[-0.015em]">
                Welcome to Schema Studio
              </h1>
              <p className="text-[13.5px] mt-1.5" style={{ color: "var(--text-2)" }}>
                Version control for your database schema.
              </p>
            </div>

            {/* divider */}
            <div className="flex items-center gap-3 my-7">
              <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
              <span
                className="text-[11px]"
                style={{ color: "var(--text-3)", letterSpacing: ".06em", textTransform: "uppercase" }}
              >
                {desktop ? "Sign in with your work account" : "Sign in or create an account"}
              </span>
              <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
            </div>

            {/* state-swappable region — `key` remounts it so the fade replays */}
            <div className="swap" key={ssoReady === false ? "unconfigured" : status}>
              {ssoReady === false && (
                <div>
                  <div className="banner mb-3" role="alert">
                    <AlertCircleIcon size={16} className="ico" />
                    <div className="body">
                      <div className="title">Single sign-on is not set up.</div>
                      {desktop ? (
                        <div style={{ color: "var(--text-2)" }}>
                          This copy of the desktop app was built without its
                          Microsoft sign-in IDs, so there is nothing to sign in
                          against. Whoever built it needs to add
                          AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID to
                          desktop/.env.desktop, then build it again.
                        </div>
                      ) : (
                        <div style={{ color: "var(--text-2)" }}>
                          This server has no sign-in credentials, so there is
                          nothing to sign in against. Whoever runs it needs to
                          set NEXTAUTH_SECRET, plus AZURE_AD_CLIENT_ID,
                          AZURE_AD_CLIENT_SECRET and AZURE_AD_TENANT_ID for
                          Microsoft or GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
                          for GitHub, then restart.
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sso-btn"
                    disabled
                    aria-label="Continue with Microsoft (unavailable)"
                  >
                    <MsMark />
                    <span className="label">Continue with Microsoft</span>
                    <ChevronRightIcon size={14} className="chev" />
                  </button>
                </div>
              )}

              {ssoReady === null && status === "idle" && (
                <div>
                  {/* Only while the server says which ways it offers, which is
                      quick; a guessed button could be one it does not have. */}
                  <button type="button" className="sso-btn" disabled aria-busy="true">
                    <span className="spin" aria-hidden="true" />
                    <span className="label">Loading sign-in…</span>
                    <ChevronRightIcon size={14} className="chev" />
                  </button>
                </div>
              )}

              {ssoReady === true && status === "idle" && (
                <div>
                  <div className="flex flex-col gap-2.5">
                    {vias.map((way) => (
                      <button
                        key={way}
                        type="button"
                        className="sso-btn"
                        onClick={() => handleLogin(way)}
                        aria-label={`Continue with ${VIA_NAME[way]}`}
                      >
                        <ViaMark via={way} />
                        <span className="label">Continue with {VIA_NAME[way]}</span>
                        <ChevronRightIcon size={14} className="chev" />
                      </button>
                    ))}
                  </div>
                  <p className="text-[12px] mt-3 text-center" style={{ color: "var(--text-3)" }}>
                    {desktop
                      ? "Opens your web browser for your organization's Microsoft sign-in."
                      : `You'll sign in with ${vias.map((way) => VIA_NAME[way]).join(" or ")}, then come straight back here.`}
                  </p>
                </div>
              )}

              {ssoReady !== false && status === "waiting" && (
                <div>
                  <button type="button" className="sso-btn" disabled aria-busy="true">
                    <span className="spin" aria-hidden="true" />
                    <span className="label">Waiting for your browser…</span>
                    <ChevronRightIcon size={14} className="chev" />
                  </button>
                  <div className="mt-3 flex flex-col items-center gap-2 text-center">
                    <p className="text-[12px]" style={{ color: "var(--text-3)" }}>
                      Finish signing in with Microsoft in your web browser. This
                      window carries on by itself once you have.
                    </p>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => getDesktopBridge()?.cancelSignIn()}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {ssoReady !== false && status === "finishing" && (
                <div>
                  <button type="button" className="sso-btn" disabled aria-busy="true">
                    <span className="spin" aria-hidden="true" />
                    <span className="label">Signing you in…</span>
                    <ChevronRightIcon size={14} className="chev" />
                  </button>
                </div>
              )}

              {ssoReady !== false && status === "redirecting" && (
                <div>
                  <button type="button" className="sso-btn" disabled aria-busy="true">
                    <span className="spin" aria-hidden="true" />
                    <span className="label">Redirecting to {VIA_NAME[via]}…</span>
                    <ChevronRightIcon size={14} className="chev" />
                  </button>
                  <div
                    className="mt-3 flex items-center justify-center gap-2 text-[12px]"
                    style={{ color: "var(--text-3)" }}
                  >
                    <span className="mono">{VIA_SCOPES[via]}</span>
                  </div>
                </div>
              )}

              {ssoReady !== false && status === "error" && (
                <div>
                  <div className="banner mb-3" role="alert">
                    <AlertCircleIcon size={16} className="ico" />
                    <div className="body">
                      <div className="title">
                        {errorMsg ?? "Sign-in failed or was cancelled."}
                      </div>
                      <div style={{ color: "var(--text-2)" }}>
                        Try again, or contact your administrator if the problem persists.
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {vias.map((way) => (
                      <button
                        key={way}
                        type="button"
                        className="sso-btn"
                        onClick={() => handleLogin(way)}
                        aria-label={`Retry with ${VIA_NAME[way]}`}
                      >
                        <ViaMark via={way} />
                        <span className="label">Retry with {VIA_NAME[way]}</span>
                        <RefreshIcon size={14} className="chev" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* inline help */}
            <div
              className="mt-6 pt-5 flex items-center justify-between gap-3 text-[12px]"
              style={{ color: "var(--text-3)", borderTop: "1px solid var(--border)" }}
            >
              <span className="inline-flex items-center gap-2">
                <LockIcon size={13} /> Encrypted in transit · single sign-on
              </span>
              <button
                type="button"
                className="flink cursor-pointer"
                aria-expanded={helpOpen}
                aria-controls="signin-help"
                onClick={() => setHelpOpen((open) => !open)}
              >
                Trouble signing in?
              </button>
            </div>
            <p
              id="signin-help"
              hidden={!helpOpen}
              className="mt-3 text-[12px] leading-relaxed"
              style={{ color: "var(--text-2)" }}
            >
              {desktop
                ? "Sign in with your work Microsoft account. If Microsoft turns you away, ask " +
                  "your administrator whether your account may use Schema Studio. Once you are " +
                  "in, an admin chooses what you can do here. New people start as Viewers, who " +
                  "can look around but not change anything."
                : "If someone invited you, sign in with an account that uses the email address " +
                  "the invitation went to, then open the invitation link again. Otherwise, sign " +
                  "in to make an organization of your own. Inside an organization, its admins " +
                  "choose what you can do. If the sign-in turns you away, ask whoever runs this " +
                  "server which accounts it accepts."}
            </p>
          </article>

          {/* under-card meta */}
          <div
            className="mt-5 flex items-center justify-end gap-4 text-[12px]"
            style={{ color: "var(--text-3)" }}
          >
            <div className="inline-flex items-center gap-2 mono">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: "var(--sync)" }}
              />
              <span>v2.0.0</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}