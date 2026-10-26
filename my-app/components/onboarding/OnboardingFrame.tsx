"use client";

import type { ReactNode } from "react";
import { LandingThemeToggle } from "@/components/landing/LandingThemeToggle";
import { LogoIcon, SignOutIcon } from "@/components/ui/icons";
import { signOutEverywhere } from "@/lib/sign-out";

/**
 * The page around "Your organizations" (components/onboarding/OnboardingPage.tsx)
 * and an invitation (components/invite/InvitePage.tsx).
 *
 * Both are where someone stands between signing in and being inside an
 * organization, so neither has the studio's rail around it. They look like the
 * sign-in page instead: the same backdrop, a small header with the theme
 * switch, and one card in the middle, headed by the logo, a title and a line
 * under it. What goes in the card below that is the page's own.
 *
 * `signedIn` puts Sign out in the header. It is false in the demo, where
 * nobody is signed in to sign out.
 */
export function OnboardingFrame({
  title,
  lede,
  signedIn,
  children,
}: {
  title: string;
  lede: ReactNode;
  signedIn: boolean;
  children: ReactNode;
}) {
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
          {signedIn && (
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
              <h1 className="text-[24px] font-semibold tracking-[-0.015em]">{title}</h1>
              <p className="text-[13.5px] mt-1.5" style={{ color: "var(--text-2)" }}>
                {lede}
              </p>
            </div>
            {children}
          </article>
        </div>
      </main>
    </div>
  );
}

/**
 * The first character of an organization's name, for the square beside it in
 * both pages. Array.from keeps a whole emoji.
 */
export function initialOf(name: string): string {
  return (Array.from(name)[0] ?? "?").toUpperCase();
}
