/**
 * What the preload scripts (src/preload) give the app's own two pages, as
 * the pages' scripts see it. A page opened anywhere else gets none of them,
 * so any may be missing.
 */
interface Window {
  schemaStudioStartup?: import("../shared/ipc").StartupApi;
  schemaStudioSettings?: import("../shared/ipc").SettingsApi;
  schemaStudioPhone?: import("../shared/ipc").PhoneSettingsApi;
}
