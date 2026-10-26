"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { OnboardingFrame, initialOf } from "@/components/onboarding/OnboardingFrame";
import { AlertCircleIcon, ChevronRightIcon, RefreshIcon } from "@/components/ui/icons";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import { apiFetch } from "@/lib/api-fetch";
import { loginHref } from "@/lib/callback-url";
import type { InviteLookup } from "@/lib/invites-db";
import { isOrgSummary, type OrgSummary } from "@/lib/organization-list";
import { orgHref } from "@/lib/org-slug";
import { signOutEverywhere } from "@/lib/sign-out";

/**
 * What the invitation page found, as app/invite/[token]/page.tsx hands it
 * over: what the invitation is to this person (lib/invites-db.ts InviteLookup),
 * or one of the reasons it was not looked up at all.
 *
 * - "demo": sign-in is switched off, so there is nobody to join as.
 * - "signed-out": the session has no profile in it, so there is nobody to look
 *   the invitation up for until they sign in again.
 * - "unavailable": the database did not answer.
 */
export type InviteView =
  | InviteLookup
  | { kind: "demo" }
  | { kind: "signed-out" }
  | { kind: "unavailable" };

const UNREACHABLE = "Could not reach the server. Check your connection, then try again.";

/** Where everyone who cannot use the invitation is pointed: what they already have. */
const YOUR_ORGANIZATIONS = "/onboarding";

/**
 * An invitation: the client side of app/invite/[token]/page.tsx, which looks
 * it up and says why the page is careful with its address.
 *
 * Each view is one card on the onboarding frame. Only an invitation this
 * person can take has a Join button. The others say why it cannot be taken
 * and what to do instead, and none of them show more about the invitation
 * than the server chose to tell (lib/invites-db.ts InviteLookup says what).
 */
export function InvitePage({ token, view }: { token: string; view: InviteView }) {
  // Where to come back to after signing in again. The token is encoded
  // because it is whatever was in the address: a real one has nothing in it
  // that needs it, but a mangled one could.
  const here = `/invite/${encodeURIComponent(token)}`;
  const signedIn = view.kind !== "demo";

  switch (view.kind) {
    case "ok":
      return (
        <OnboardingFrame
          title={`Join ${view.organization.name}`}
          lede={
            view.invite === "email"
              ? "You have been invited to join this organization."
              : "This link lets you join this organization."
          }
          signedIn={signedIn}
        >
          <JoinCard
            token={token}
            here={here}
            organization={view.organization}
            roleLabel={view.roleLabel}
            invite={view.invite}
          />
        </OnboardingFrame>
      );

    case "member":
      return (
        <OnboardingFrame
          title={`You are already in ${view.organization.name}`}
          lede="This invitation is for an organization you belong to, so there is nothing to join."
          signedIn={signedIn}
        >
          <div className="inv-actions">
            <Link className="btn btn-primary w-full" href={orgHref(view.organization.slug, "/studio")}>
              <span>Open {view.organization.name}</span>
              <ChevronRightIcon size={14} />
            </Link>
          </div>
        </OnboardingFrame>
      );

    case "wrong-account":
      return (
        <OnboardingFrame
          title="This invitation is for another account"
          lede={
            <>
              The invitation to join {view.organization.name} was sent to{" "}
              <span className="mono">{view.maskedEmail}</span>. Sign in with that address to take
              it.
            </>
          }
          signedIn={signedIn}
        >
          <SwitchAccount here={here} />
        </OnboardingFrame>
      );

    case "invalid":
      return (
        <DeadEnd
          title="This invitation link does not work"
          lede="Check that it was copied whole, or ask whoever sent it for a new one."
          signedIn={signedIn}
        />
      );

    case "revoked":
      return (
        <DeadEnd
          title="This invitation was cancelled"
          lede="Ask whoever sent it for a new one."
          signedIn={signedIn}
        />
      );

    case "expired":
      return (
        <DeadEnd
          title="This invitation has run out"
          lede="Invitations only last a set number of days. Ask whoever sent it for a new one."
          signedIn={signedIn}
        />
      );

    case "used":
      return (
        <DeadEnd
          title="This invitation has been used"
          lede="Each invitation to an address can be taken once. If you still need to join, ask whoever sent it for a new one."
          signedIn={signedIn}
        />
      );

    case "demo":
      return (
        <DeadEnd
          title="Invitations need a real sign-in"
          lede="Sign-in is switched off here, so there is nobody to join as."
          signedIn={signedIn}
        />
      );

    case "unavailable":
      return (
        <OnboardingFrame
          title="Could not read the invitation"
          lede="The app's database may be unreachable. Try again in a moment."
          signedIn={signedIn}
        >
          <TryAgain />
        </OnboardingFrame>
      );

    case "signed-out":
    case "no-profile":
      return (
        <OnboardingFrame
          title="Sign in again to continue"
          lede="Your session has ended. Sign in, and you will come straight back to this invitation."
          signedIn={signedIn}
        >
          <div className="inv-actions">
            <Link className="btn btn-primary w-full" href={loginHref(here)}>
              Sign in
            </Link>
          </div>
        </OnboardingFrame>
      );
  }
}

/** What pressing Join came to, short of joining. */
type Refused = { message: string; signedOut: boolean };

/**
 * The organization, the role this person would have in it, and Join.
 *
 * Join asks app/api/invites/accept/route.ts, which checks the invitation again
 * before letting anyone in, so it can still refuse: the invitation may have
 * been cancelled since this page was drawn. Its refusal shows here, and when
 * it says what became of the invitation (`state`), the page is drawn again
 * from the server, so it shows the matching view instead of a Join button
 * that can only fail. Its own state goes with it, which is why it lives in
 * this card rather than in InvitePage.
 */
function JoinCard({
  token,
  here,
  organization,
  roleLabel,
  invite,
}: {
  token: string;
  here: string;
  organization: OrgSummary;
  roleLabel: string;
  invite: "email" | "link";
}) {
  const router = useRouter();
  /** "joining" while the server works, "opening" once it has and the studio loads. */
  const [stage, setStage] = useState<"joining" | "opening" | null>(null);
  const [refused, setRefused] = useState<Refused | null>(null);

  async function join() {
    if (stage) return;
    setStage("joining");
    setRefused(null);

    let response: Response;
    try {
      response = await apiFetch("/api/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      setStage(null);
      setRefused({ message: UNREACHABLE, signedOut: false });
      return;
    }
    const body = await jsonOf(response);

    if (response.ok) {
      // The route answers with the organization to open, which is also the
      // answer when this person turned out to be in it already. The button
      // stays busy until the studio replaces this page.
      const joined = (body as { organization?: unknown } | null)?.organization;
      if (isOrgSummary(joined)) {
        setStage("opening");
        router.push(orgHref(joined.slug, "/studio"));
        return;
      }
      setStage(null);
      setRefused({
        message: "The server's answer could not be read. Try again in a moment.",
        signedOut: false,
      });
      return;
    }

    setStage(null);
    setRefused({
      message: errorFrom(body) ?? `Could not take the invitation (HTTP ${response.status}).`,
      signedOut: response.status === 401,
    });
    if (typeof (body as { state?: unknown } | null)?.state === "string") router.refresh();
  }

  return (
    <>
      <div className="inv-org mt-6">
        <span className="mark" aria-hidden="true">
          {initialOf(organization.name)}
        </span>
        <span className="text">
          <span className="name">{organization.name}</span>
          <span className="slug">/{organization.slug}</span>
        </span>
        <span className="pill pill-brand">
          <span className="sr-only">Joining as </span>
          {roleLabel}
        </span>
      </div>

      <div className="inv-actions">
        {refused && (
          <div className="banner" role="alert">
            <AlertCircleIcon size={16} className="ico" />
            <div className="body">
              <div className="title">{refused.message}</div>
              {refused.signedOut && (
                <Link className="flink" href={loginHref(here)}>
                  Sign in again
                </Link>
              )}
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary w-full"
          onClick={() => void join()}
          disabled={stage !== null}
          aria-busy={stage !== null || undefined}
        >
          {stage ? (
            <>
              <span className="spin" aria-hidden="true" />
              <span>{stage === "joining" ? "Joining…" : "Opening…"}</span>
            </>
          ) : (
            <span>Join {organization.name}</span>
          )}
        </button>
        <p className="help text-center">
          {invite === "link"
            ? `Everyone who joins through a link starts as a ${roleLabel}. An Admin there can change your role later.`
            : "An Admin there can change your role later."}
        </p>
      </div>
    </>
  );
}

/**
 * An invitation to an address this person has not signed in with.
 *
 * Signing out and in again is not enough on its own: Microsoft and GitHub
 * would both sign straight back in to the account the browser last used. So
 * the login page is told to ask for their account picker (lib/callback-url.ts
 * loginHref), and afterwards it comes back here to try again as whoever they
 * chose.
 */
function SwitchAccount({ here }: { here: string }) {
  const [leaving, setLeaving] = useState(false);

  function switchAccount() {
    setLeaving(true);
    void signOutEverywhere(loginHref(here, { chooseAccount: true }));
  }

  return (
    <div className="inv-actions">
      <button
        type="button"
        className="btn btn-primary w-full"
        onClick={switchAccount}
        disabled={leaving}
        aria-busy={leaving || undefined}
      >
        {leaving ? (
          <>
            <span className="spin" aria-hidden="true" />
            <span>Signing out…</span>
          </>
        ) : (
          <span>Sign in with another account</span>
        )}
      </button>
      <Link className="btn btn-secondary w-full" href={YOUR_ORGANIZATIONS}>
        Your organizations
      </Link>
    </div>
  );
}

/** An invitation that cannot be taken: the reason, and a way back to what this person has. */
function DeadEnd({ title, lede, signedIn }: { title: string; lede: string; signedIn: boolean }) {
  return (
    <OnboardingFrame title={title} lede={lede} signedIn={signedIn}>
      <div className="inv-actions">
        <Link className="btn btn-secondary w-full" href={YOUR_ORGANIZATIONS}>
          Your organizations
        </Link>
      </div>
    </OnboardingFrame>
  );
}

/**
 * Asks the server to look the invitation up again. A refresh redraws the page
 * from the server without a full reload, and the transition keeps the button
 * busy until the new view is in.
 */
function TryAgain() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="inv-actions">
      <button
        type="button"
        className="btn btn-secondary w-full"
        onClick={() => startTransition(() => router.refresh())}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending ? <span className="spin" aria-hidden="true" /> : <RefreshIcon size={14} />}
        <span>Try again</span>
      </button>
    </div>
  );
}
