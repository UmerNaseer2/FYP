import Link from "next/link";
import type { ReactNode } from "react";
import {
  CompareIcon,
  DeployIcon,
  DriftIcon,
  LockIcon,
  LogoIcon,
  MonitorIcon,
  SchemaMapIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { LandingThemeToggle } from "./LandingThemeToggle";

/**
 * The public front page at "/": what Schema Studio is, what it does, and two
 * ways in.
 *
 * A Server Component with no state of its own. app/page.tsx decides where the
 * two buttons go (the sign-in page, or straight into the studio on a demo
 * server) and whether this server encrypts the passwords it stores, and hands
 * both down as props, so this file only lays them out. The theme switch is
 * the one piece that runs in the browser (LandingThemeToggle).
 *
 * Exactly two links on purpose, "Create account" and "Log in". The name in
 * the header is not a link: on the front page it would only lead back here.
 *
 * Styles are the .landing-* section of app/globals.css. The background grid
 * and color washes are the sign-in page's, so the two pages read as one place.
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
      "to an earlier version if you need to. Production deploys wait for a second person to " +
      "approve them.",
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

export function LandingPage({ createAccountHref, logInHref, encryptsPasswords, demo = false }: LandingPageProps) {
  return (
    <div className="landing">
      <div className="landing-backdrop" aria-hidden="true">
        <div className="bg-grid" />
        <div className="bg-wash-a" />
        <div className="bg-wash-b" />
      </div>

      <header className="landing-header">
        <div className="landing-wrap landing-header__inner">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg grid place-items-center text-white" style={{ background: "var(--brand)" }}>
              <LogoIcon size={15} />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-[13.5px]">Schema Studio</div>
              <div className="text-[11px] mono" style={{ color: "var(--text-3)" }}>v2.0.0</div>
            </div>
          </div>
          <LandingThemeToggle />
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-wrap landing-hero" aria-labelledby="landing-title">
          <div>
            <span className="pill pill-brand">
              <span className="dot" />
              Version control for database schemas
            </span>
            <h1 id="landing-title" className="landing-title">
              Keep dev, staging and prod from drifting apart.
            </h1>
            <p className="landing-lede">
              Schema Studio compares your database schemas across environments, tells you when one
              changes behind your back, and deploys the fix with a second person signing off on
              production.
            </p>
            <div className="landing-ctas">
              <Link href={createAccountHref} className="btn btn-primary btn-lg">
                Create account
              </Link>
              <Link href={logInHref} className="btn btn-secondary btn-lg">
                Log in
              </Link>
            </div>
            <p className="landing-note">
              {demo
                ? "This is a demo server with sign-in switched off, so both buttons open the studio."
                : "New here? Your account is created the first time you sign in."}
            </p>
          </div>

          <figure className="landing-preview" aria-label="Example: one schema in three environments">
            <div className="landing-preview__head">
              <span className="landing-preview__schema">finance</span>
              <span className="pill pill-neutral">Example</span>
            </div>
            <ul className="landing-envs">
              {EXAMPLE_ENVIRONMENTS.map((env) => (
                <li key={env.name} className="landing-env">
                  <span className="landing-env__name">{env.name}</span>
                  <span className="landing-env__version">{env.version}</span>
                  <span className={`pill ${env.tone}`}>
                    <span className="dot" />
                    {env.status}
                  </span>
                </li>
              ))}
            </ul>
            <div className="landing-diff">
              <div className="diff-row diff-chg">
                <span className="sign">~</span>
                <span className="landing-diff__body">
                  <span className="landing-diff__code">invoices.amount numeric(10,2) → numeric(12,2)</span>
                  <span className="landing-diff__where">Staging, changed by hand</span>
                </span>
              </div>
              <div className="diff-row diff-add">
                <span className="sign">+</span>
                <span className="landing-diff__body">
                  <span className="landing-diff__code">invoice_lines.id uuid PRIMARY KEY</span>
                  <span className="landing-diff__where">Prod, waiting to deploy</span>
                </span>
              </div>
            </div>
            <figcaption className="landing-preview__foot">
              <span className="landing-preview__lock">
                <LockIcon size={14} />
                Production deploys wait for a second person.
              </span>
              <span className="pill pill-pending">1 approval needed</span>
            </figcaption>
          </figure>
        </section>

        <section className="landing-wrap landing-section" aria-labelledby="landing-features">
          <h2 id="landing-features" className="section-title landing-section__title">
            What it does
          </h2>
          <ul className="landing-features">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="landing-feature">
                <span className="landing-feature__icon" aria-hidden="true">
                  {feature.icon}
                </span>
                <h3 className="landing-feature__title">{feature.title}</h3>
                <p className="landing-feature__body">{feature.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-wrap landing-section" aria-labelledby="landing-storage">
          <div className="landing-store">
            <span className="landing-store__icon" aria-hidden="true">
              <LockIcon size={16} />
            </span>
            <div>
              <h2 id="landing-storage" className="landing-store__title">
                What gets stored
              </h2>
              <p className="landing-store__body">
                {encryptsPasswords
                  ? "Schema Studio stores the database connections you add, with each password " +
                    "encrypted using AES-256-GCM. Deleting a connection deletes its password too."
                  : "Schema Studio stores the database connections you add. This server has no " +
                    "encryption key set, so their passwords are stored as typed. Deleting a " +
                    "connection deletes its password too."}
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-wrap landing-footer__inner">
          <span>Schema Studio</span>
          <span className="mono">v2.0.0</span>
        </div>
      </footer>
    </div>
  );
}
