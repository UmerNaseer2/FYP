"use client";

import type { ReactNode } from "react";
import { LandingThemeToggle } from "@/components/landing/LandingThemeToggle";
import { BrandMark } from "@/components/ui/BrandMark";
import { SignOutIcon } from "@/components/ui/icons";
import { signOutEverywhere } from "@/lib/sign-out";
import "@/app/styles/atelier-onboarding.css";

/**
 * The page around "Your organizations" (components/onboarding/OnboardingPage.tsx)
 * and an invitation (components/invite/InvitePage.tsx).
 *
 * Both are where someone stands between signing in and being inside an
 * organization, so neither has the studio's rail around it. They follow the
 * sign-in page instead: a small header with the brand, the theme switch and
 * Sign out, and one card in the middle, headed by the mark, a title and a line
 * under it. What goes in the card below that is the page's own.
 *
 * The look lives in app/styles/atelier-onboarding.css (classes start with ob-,
 * plus the pages' own onb- and inv- pieces).
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
    <div className="ob-page">
      <header className="ob-nav">
        <div className="brand">
          <BrandMark size={30} />
          <span className="brand-name ob-brand-name">Schema Studio</span>
        </div>
        <div className="ob-tools">
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

      <main className="ob-main">
        <article className="card ob-card">
          <div className="ob-head">
            <BrandMark size={44} className="ob-mark" />
            <h1>{title}</h1>
            <p>{lede}</p>
          </div>
          {children}
        </article>
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
