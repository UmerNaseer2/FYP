/**
 * The version the app shows beside its name: on the sidebar, the sign-in page
 * and the landing page.
 *
 * It is the desktop app's version as well, because the desktop app ships these
 * same screens. A test (tests/app-version.test.ts) keeps it equal to the
 * "version" in my-app/package.json and in desktop/package.json, so the screens
 * and the packages cannot drift apart again: the screens said v2.0.0 for weeks
 * while this package still said 0.1.0.
 */
export const APP_VERSION = "2.0.0";
