import Link from "next/link";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { APP_VERSION } from "@/lib/ui/app-version";
import {
  CompareIcon,
  DeployIcon,
  DriftIcon,
  LockIcon,
  SchemaMapIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { BrandMark } from "@/components/ui/BrandMark";
import { StatusChip } from "@/components/ui/StatusChip";
import { LandingThemeToggle } from "./LandingThemeToggle";
import { LandingReveal, SectionButton } from "./LandingMotion";
import "@/app/styles/atelier-landing.css";

/**
 * The public front page at "/": what Schema Studio is, what it does, and the
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
  /** True when this server encrypts the database passwords it stores (lib/connections/secret-store.ts). */
  encryptsPasswords: boolean;
  /** A demo server with sign-in switched off, where both buttons open the studio. */
  demo?: boolean;
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
    title: "Compare your databases",
    body:
      "Line up two schemas side by side: tables, columns, indexes, constraints, views " +
      "and more. Get the SQL that brings one in line with the other.",
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
      "to an earlier version if you need to. Someone whose role may not run it asks for approval " +
      "of that exact run.",
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
];

/**
 * The steps under "How it works", in the order the app's own menu and tour
 * use. Each says only what FEATURES says.
 */
const STEPS = [
  { title: "Connect", body: "Add a database connection." },
  { title: "Compare", body: "See every difference between two schemas, side by side." },
  { title: "Script", body: "Turn the differences into a migration script, checked for risks." },
  {
    title: "Ship",
    body: "Rehearse with a dry run, then deploy. A run your role does not allow waits for an Admin.",
  },
  { title: "Watch", body: "Get told when someone changes a schema outside a deploy." },
];

/** How wide each feature card is on the six-column grid, in FEATURES order. */
const FEATURE_SPANS = ["s4 dark", "s2", "s2", "s4", "s6"];

const TITLE = "Catch the schema changes nobody shipped.";

/** A delay in milliseconds for the CSS entrance animations (--d). */
function delay(ms: number): CSSProperties {
  return { "--d": ms } as CSSProperties;
}

export function LandingPage({
  createAccountHref,
  logInHref,
  encryptsPasswords,
  demo = false,
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
              <p className="lp-sub lp-in" style={delay(460)}>
                Schema Studio compares your schemas, writes the script that brings them in line,
                and watches for changes made outside a deploy.
              </p>
              <div className="lp-cta lp-in" style={delay(540)}>
                <Link href={createAccountHref} className="btn btn-primary btn-lg">
                  Create account
                </Link>
                <Link href={logInHref} className="btn btn-secondary btn-lg">
                  Log in
                </Link>
              </div>
              <p className="lp-fine lp-in" style={delay(680)}>
                {demo
                  ? "This is a demo server with sign-in switched off, so both buttons open the studio."
                  : "New here? Your account is created the first time you sign in."}
              </p>
            </div>

            {/* One kind of change and the approval rule, and nothing else. */}
            <figure className="card lp-stage" aria-label="Example: a schema that has drifted">
              <div className="lp-dh">
                <span className="pill pill-neutral">Example</span>
                <b className="mono">finance</b>
                <StatusChip status="drifted" />
              </div>
              <div className="lp-change">
                <i className="g chg" aria-hidden="true">~</i>
                <div>
                  <b>invoices.amount numeric(10,2) → numeric(12,2)</b>
                  <span>Changed by hand, outside a deploy</span>
                </div>
              </div>
              <figcaption className="lp-cap">
                <LockIcon size={16} />
                <span>A run your role does not allow waits for an Admin.</span>
              </figcaption>
            </figure>
          </section>

          <section className="lp-sec lp-rv" id="lp-how" tabIndex={-1} aria-labelledby="landing-how">
            <small id="landing-how">How it works</small>
            <h2>Five steps, and none of them is a surprise.</h2>
            <ol className="lp-steps">
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
