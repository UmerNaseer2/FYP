import Link from "next/link";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { APP_VERSION } from "@/lib/app-version";
import {
  CompareIcon,
  DeployIcon,
  DriftIcon,
  LockIcon,
  MonitorIcon,
  SchemaMapIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { BrandMark } from "@/components/ui/BrandMark";
import { LandingThemeToggle } from "./LandingThemeToggle";
import { LandingReveal, SectionButton } from "./LandingMotion";
import { TRIAL_PEOPLE, TRIAL_ROLES } from "@/lib/trial-rules";
import "@/app/styles/atelier-landing.css";

/**
 * The public front page at "/": what Schema Studio is, what it does, and two
 * ways in.
 *
 * A Server Component with no state of its own. app/page.tsx decides where the
 * two buttons go (the sign-in page, or straight into the studio on a demo
 * server) and whether this server encrypts the passwords it stores, and hands
 * both down as props, so this file only lays them out. The theme switch, the
 * section buttons and the scroll fade-in are the pieces that run in the
 * browser (LandingThemeToggle, LandingMotion).
 *
 * Exactly two links on purpose, "Create account" and "Log in". The name in
 * the header is not a link: on the front page it would only lead back here,
 * and the header's section buttons only scroll.
 *
 * The Atelier design. Styles are app/styles/atelier-landing.css (every class
 * starts with lp-).
 */

export type LandingPageProps = {
  /** Where "Create account" goes. */
  createAccountHref: string;
  /** Where "Log in" goes. */
  logInHref: string;
  /** True when this server encrypts the database passwords it stores (lib/secret-store.ts). */
  encryptsPasswords: boolean;
  /** A demo server with sign-in switched off, where both buttons open the studio. */
  demo?: boolean;
  /**
   * Where the shared trial's buttons post to (app/api/trial/route.ts), when
   * this server offers the trial (lib/trial-rules.ts).
   */
  trialAction?: string;
};

type Feature = { icon: ReactNode; title: string; body: string };

/**
 * What the product does, in the words a visitor would use. Every claim here
 * was checked against the code that does it: change a line only together with
 * that code.
 */
const FEATURES: Feature[] = [
  {
    icon: <CompareIcon size={18} />,
    title: "Compare across environments",
    body:
      "Line up dev, staging and prod side by side: tables, columns, indexes, constraints, views " +
      "and more. Get the SQL that brings one in line with another.",
  },
  {
    icon: <DriftIcon size={18} />,
    title: "Scheduled drift checks",
    body:
      "Track a schema and Schema Studio checks it on a schedule you set. A change made by hand " +
      "shows up as drift, so you find it before your next deploy does.",
  },
  {
    icon: <DeployIcon size={18} />,
    title: "Deploy and roll back",
    body:
      "Check a migration for risks and rehearse it with a dry run before it runs, then roll back " +
      "to an earlier version if you need to. By default, production deploys wait for a second " +
      "person to approve them.",
  },
  {
    icon: <UsersIcon size={18} />,
    title: "Roles and permissions",
    body:
      "Decide who can see, create, change, delete, run or approve, feature by feature. Viewer, " +
      "Editor and Admin to start with, plus roles of your own.",
  },
  {
    icon: <SchemaMapIcon size={18} />,
    title: "Schema diagrams",
    body: "See any schema as a diagram of its tables and the foreign keys between them.",
  },
  {
    icon: <MonitorIcon size={18} />,
    title: "Desktop app and phone approvals",
    body:
      "Run Schema Studio as an app on Ubuntu 20.04 or newer. Pair your phone with it to approve " +
      "production deploys with a passkey and to get drift alerts.",
  },
];

/**
 * The hero's example: one schema in three environments. Made up, and the card
 * says so. The status words and pill colors are the dashboard's own, and the
 * versions are spelled the way Deploy prints them.
 */
const EXAMPLE_ENVIRONMENTS = [
  { name: "Dev", version: "v2.4.0", tone: "pill-sync", status: "In sync" },
  { name: "Staging", version: "v2.4.0", tone: "pill-drift", status: "Drifted" },
  { name: "Prod", version: "v2.3.0", tone: "pill-pending", status: "Outdated" },
];

/** The three steps under "How it works". Each says only what FEATURES says. */
const STEPS = [
  {
    title: "Compare",
    body: "Pick two environments. Every table, column, index and constraint that differs is listed side by side.",
  },
  {
    title: "Script",
    body: "Get the SQL that brings one in line with the other, and check it for risks before anything runs.",
  },
  {
    title: "Ship",
    body:
      "Rehearse it with a dry run, then deploy. By default production waits for a second person, " +
      "and you can roll back to an earlier version.",
  },
];

/** How wide each feature card is on the six-column grid, in FEATURES order. */
const FEATURE_SPANS = ["s4 dark", "s2", "s2", "s4", "s3", "s3"];

const TITLE = "Keep dev, staging and prod from drifting apart.";

/** A delay in milliseconds for the CSS entrance animations (--d). */
function delay(ms: number): CSSProperties {
  return { "--d": ms } as CSSProperties;
}

export function LandingPage({
  createAccountHref,
  logInHref,
  encryptsPasswords,
  demo = false,
  trialAction,
}: LandingPageProps) {
  return (
    <div className="lp-page">
      <LandingReveal />
      <div className="lp">
        <header className="lp-nav">
          <div className="brand">
            <BrandMark />
            <span className="brand-name">Schema Studio</span>
            <span className="brand-v mono">v{APP_VERSION}</span>
          </div>
          <nav className="lp-links" aria-label="On this page">
            <SectionButton target="lp-how">How it works</SectionButton>
            <SectionButton target="lp-what">What it does</SectionButton>
            <SectionButton target="lp-store">What gets stored</SectionButton>
          </nav>
          <LandingThemeToggle />
        </header>

        <main>
          <section className="lp-hero" aria-labelledby="landing-title">
            <div>
              <span className="lp-eyebrow">Version control for database schemas</span>
              <h1 id="landing-title" tabIndex={-1} aria-label={TITLE}>
                {TITLE.split(" ").map((word, index) => (
                  <Fragment key={index}>
                    {index > 0 && " "}
                    <span className="lp-w">
                      <span style={delay(60 + index * 70)}>{word}</span>
                    </span>
                  </Fragment>
                ))}
              </h1>
              <p className="lp-sub lp-in" style={delay(560)}>
                Schema Studio compares your database schemas across environments, tells you when one
                changes behind your back, and by default deploys the fix to production only after a
                second person signs off.
              </p>
              <div className="lp-cta lp-in" style={delay(640)}>
                <Link href={createAccountHref} className="btn btn-primary btn-lg">
                  Create account
                </Link>
                <Link href={logInHref} className="btn btn-secondary btn-lg">
                  Log in
                </Link>
              </div>
              <p className="lp-fine lp-in" style={delay(700)}>
                {demo
                  ? "This is a demo server with sign-in switched off, so both buttons open the studio."
                  : "New here? Your account is created the first time you sign in."}
              </p>
              {trialAction && (
                <form action={trialAction} method="post" className="lp-trial lp-in" style={delay(740)}>
                  <p className="lp-trial__lead">
                    Or try it first, no account needed. Everyone shares one trial organization, and it
                    starts fresh every night.
                  </p>
                  <div className="lp-trial__row">
                    {TRIAL_ROLES.map((role) => (
                      <button key={role} type="submit" name="role" value={role} className="btn btn-secondary">
                        Try as {TRIAL_PEOPLE[role].name.replace("Trial ", "")}
                      </button>
                    ))}
                  </div>
                </form>
              )}
            </div>

            <figure className="card lp-stage" aria-label="Example: one schema in three environments">
              <div className="lp-dh">
                <b>finance</b>
                <span className="pill pill-neutral">Example</span>
              </div>
              <ul className="lp-envs">
                {EXAMPLE_ENVIRONMENTS.map((env, index) => (
                  <li key={env.name} style={delay(420 + index * 90)}>
                    <b>{env.name}</b>
                    <code>{env.version}</code>
                    <span className={`pill ${env.tone}`}>
                      <span className="dot" />
                      {env.status}
                    </span>
                  </li>
                ))}
              </ul>
              <ul className="lp-df">
                <li style={delay(720)}>
                  <i className="g chg" aria-hidden="true">~</i>
                  <div>
                    <b>invoices.amount numeric(10,2) → numeric(12,2)</b>
                    <span>Staging, changed by hand</span>
                  </div>
                </li>
                <li style={delay(800)}>
                  <i className="g add" aria-hidden="true">+</i>
                  <div>
                    <b>invoice_lines.id uuid PRIMARY KEY</b>
                    <span>Prod, waiting to deploy</span>
                  </div>
                </li>
              </ul>
              <figcaption className="lp-cap">
                <span className="lp-lock">
                  <LockIcon size={14} />
                  Production deploys wait for a second person by default.
                </span>
                <span className="pill pill-pending">1 approval needed</span>
              </figcaption>
            </figure>
          </section>

          <section className="lp-sec lp-rv" id="lp-how" tabIndex={-1} aria-labelledby="landing-how">
            <small id="landing-how">How it works</small>
            <h2>Three steps, and none of them is a surprise.</h2>
            <ol className="lp-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="card">
                  <i className="n" aria-hidden="true">{index + 1}</i>
                  <b>{step.title}</b>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </section>

          <section className="lp-sec lp-rv" id="lp-what" tabIndex={-1} aria-labelledby="landing-features">
            <small id="landing-features">What it does</small>
            <h2>Everything around the change, too.</h2>
            <ul className="lp-bento">
              {FEATURES.map((feature, index) => (
                <li key={feature.title} className={`card ${FEATURE_SPANS[index] ?? "s2"}`}>
                  <span className="lp-ic" aria-hidden="true">
                    {feature.icon}
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="lp-sec lp-rv" id="lp-store" tabIndex={-1} aria-labelledby="landing-storage">
            <small id="landing-storage">What gets stored</small>
            <h2>Where your passwords go.</h2>
            <div className="card lp-store">
              <span className="lp-ic" aria-hidden="true">
                <LockIcon size={18} />
              </span>
              <p>
                {encryptsPasswords
                  ? "Schema Studio stores the database connections you add, with each password " +
                    "encrypted using AES-256-GCM. Deleting a connection deletes its password too."
                  : "Schema Studio stores the database connections you add. This server has no " +
                    "encryption key set, so their passwords are stored as typed. Deleting a " +
                    "connection deletes its password too."}
              </p>
            </div>
          </section>

          <div className="lp-sec lp-rv lp-end">
            <h2>Your next migration can be a quiet one.</h2>
            <SectionButton target="landing-title" className="btn btn-lg lp-top">
              Back to the top
            </SectionButton>
          </div>
        </main>

        <footer className="lp-ft">
          <span>Schema Studio</span>
          <span className="mono">v{APP_VERSION}</span>
        </footer>
      </div>
    </div>
  );
}
