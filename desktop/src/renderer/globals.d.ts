/**
 * What the preload scripts (src/preload) give the app's own two pages, as
 * the pages' scripts see it. A page opened anywhere else gets neither, so
 * both may be missing.
 */
interface Window {
  schemaStudioStartup?: import("../shared/ipc").StartupApi;
  schemaStudioSettings?: import("../shared/ipc").SettingsApi;
}
