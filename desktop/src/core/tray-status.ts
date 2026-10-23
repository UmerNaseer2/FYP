/**
 * The line about the phone link in the menu of the app's top bar icon.
 *
 * With Keep running on, closing the window leaves the app running with only
 * its icon in the top bar, so the icon's menu is the one place that still
 * says whether paired phones can reach this computer. This turns what the
 * phone link reports into that line. It lives apart from src/main/tray.ts,
 * which needs Electron, so that the wording can be tested in plain Node.
 *
 * Tested in src/test/tray-status.test.ts.
 */
import type { PhoneStatus, PhoneView } from "../shared/ipc";

/** The line for each state the phone link can be in, kept short for a menu. */
const TEXT: Record<PhoneStatus["state"], string> = {
  off: "Phone link: off",
  "needs-relay": "Phone link: no relay set",
  connecting: "Phone link: connecting\u{2026}",
  connected: "Phone link: connected",
  waiting: "Phone link: waiting to reconnect",
  replaced: "Phone link: another copy took over",
};

/** The menu line for what the phone link reports, including when it has not started. */
export function trayStatus(view: PhoneView): string {
  return view.available ? TEXT[view.status.state] : "Phone link: not running";
}
