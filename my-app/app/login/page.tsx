"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useTheme } from "@/hooks/useTheme";
import {
  LogoIcon,
  SunIcon,
  MoonIcon,
  ChevronRightIcon,
  RefreshIcon,
  LockIcon,
  AlertCircleIcon,
} from "@/components/ui/icons";

// Scopes kept exactly as the existing working Azure flow — auth already works,
// Phase 2 only reskins the screen around it.
const SCOPES = "email openid profile User.Read";

type Status = "idle" | "redirecting" | "error";

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

export default function LoginPage() {
  const { theme, toggleTheme } = useTheme();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleLogin() {
    setStatus("redirecting");
    setErrorMsg(null);
    const { error } = await createClient().auth.signInWithOAuth({
      provider: "azure",
      options: {
        scopes: SCOPES,
        redirectTo: `${window.location.origin}`,
      },
    });
    // On success the browser navigates to Microsoft and this page unloads,
    // so the "redirecting" state simply stays on screen until that happens.
    if (error) {
      console.error(error);
      setErrorMsg(error.message);
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
              v2.0.0 · main
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
                Sign in with your work account
              </span>
              <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
            </div>

            {/* state-swappable region — `key` remounts it so the fade replays */}
            <div className="swap" key={status}>
              {status === "idle" && (
                <div>
                  <button
                    type="button"
                    className="sso-btn"
                    onClick={handleLogin}
                    aria-label="Continue with Microsoft"
                  >
                    <MsMark />
                    <span className="label">Continue with Microsoft</span>
                    <ChevronRightIcon size={14} className="chev" />
                  </button>
                  <p className="text-[12px] mt-3 text-center" style={{ color: "var(--text-3)" }}>
                    You&apos;ll be redirected to your organization&apos;s Microsoft sign-in.
                  </p>
                </div>
              )}

              {status === "redirecting" && (
                <div>
                  <button type="button" className="sso-btn" disabled aria-busy="true">
                    <span className="spin" aria-hidden="true" />
                    <span className="label">Redirecting to Microsoft…</span>
                    <ChevronRightIcon size={14} className="chev" />
                  </button>
                  <div
                    className="mt-3 flex items-center justify-center gap-2 text-[12px]"
                    style={{ color: "var(--text-3)" }}
                  >
                    <span className="mono">{SCOPES}</span>
                  </div>
                </div>
              )}

              {status === "error" && (
                <div>
                  <div className="banner mb-3" role="alert">
                    <AlertCircleIcon size={16} className="ico" />
                    <div className="body">
                      <div className="title">Sign-in failed or was cancelled.</div>
                      <div style={{ color: "var(--text-2)" }}>
                        Try again, or contact your administrator if the problem persists.
                      </div>
                      {errorMsg && (
                        <details>
                          <summary>Details</summary>
                          <pre>{errorMsg}</pre>
                        </details>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sso-btn"
                    onClick={handleLogin}
                    aria-label="Retry with Microsoft"
                  >
                    <MsMark />
                    <span className="label">Retry with Microsoft</span>
                    <RefreshIcon size={14} className="chev" />
                  </button>
                </div>
              )}
            </div>

            {/* inline help */}
            <div
              className="mt-6 pt-5 flex items-center justify-between gap-3 text-[12px]"
              style={{ color: "var(--text-3)", borderTop: "1px solid var(--border)" }}
            >
              <span className="inline-flex items-center gap-2">
                <LockIcon size={13} /> Encrypted in transit · enterprise SSO
              </span>
              <a href="#" className="flink">
                Trouble signing in?
              </a>
            </div>
          </article>

          {/* under-card meta */}
          <div
            className="mt-5 flex items-center justify-between gap-4 text-[12px]"
            style={{ color: "var(--text-3)" }}
          >
            <div className="flex items-center gap-3">
              <a href="#" className="flink">
                Terms
              </a>
              <span style={{ opacity: 0.5 }}>·</span>
              <a href="#" className="flink">
                Privacy
              </a>
              <span style={{ opacity: 0.5 }}>·</span>
              <a href="#" className="flink">
                Status
              </a>
            </div>
            <div className="inline-flex items-center gap-2 mono">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: "var(--sync)" }}
              />
              <span>v2.0.0 · main</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
