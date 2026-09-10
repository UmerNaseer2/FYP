/**
 * Server start-up. Next calls `register()` once, in each runtime, before the
 * first request is served.
 *
 * The only thing this app needs at start-up is the drift scheduler — the loop
 * that turns "we watch your schemas for drift" from a claim into something that
 * happens. Everything else in the app is request-driven and initialises itself
 * lazily.
 *
 * Three guards, all deliberate:
 *
 *   • NEXT_RUNTIME — this file is also evaluated in the Edge runtime, where
 *     there is no `pg`, no TCP and no timer worth starting. Only Node runs it.
 *   • A dynamic import — lib/drift-scheduler reaches lib/db/sequelize, which
 *     throws at module scope when DATABASE_URL_A is missing. A static import
 *     would make a missing environment variable a server that will not boot at
 *     all, rather than a server whose pages explain what is missing.
 *   • try/catch — an optional background loop must never be the reason the app
 *     fails to start.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startDriftScheduler } = await import("./lib/drift-scheduler");
    startDriftScheduler();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Drift scheduler — could not start: ${message}`);
  }
}
