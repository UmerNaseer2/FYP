/**
 * The app's icon in the top bar, there while Keep running is on.
 *
 * With Keep running on, closing the window only hides it: the app goes on
 * running, so paired phones can still reach this computer. The icon is the
 * way back. Its menu opens the window again, says how the phone link stands
 * (src/core/tray-status.ts), and has Quit, which is otherwise only in the
 * hidden window's File menu.
 *
 * Ubuntu shows the icon through its AppIndicator extension, which is on by
 * default. Plain GNOME, without that extension, shows no icon at all. There
 * the app grid is the way back: opening Schema Studio again while it runs
 * shows its window (src/main/main.ts).
 */
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";

/**
 * The icon's size in pixels. Ubuntu's top bar scales the icon to fit, so it
 * gets one large enough to stay sharp on a high-resolution screen rather
 * than all 1024 pixels of the app's icon. A Mac's menu bar does not scale
 * it, so a run from the source code there gets one the bar's height.
 */
const SIZE = process.platform === "darwin" ? 18 : 64;

/** What the icon's menu does. */
export type TrayActions = {
  /** Shows the main window and brings it to the front. */
  open(): void;
  quit(): void;
};

export class AppTray {
  // Kept for as long as the icon should show: a Tray that is garbage
  // collected disappears from the top bar.
  private readonly tray: Tray;
  private readonly actions: TrayActions;
  private status: string;

  /** status is the menu's line about the phone link. */
  constructor(icon: string, status: string, actions: TrayActions) {
    this.actions = actions;
    this.status = status;
    this.tray = new Tray(nativeImage.createFromPath(icon).resize({ width: SIZE, height: SIZE }));
    this.tray.setToolTip("Schema Studio");
    // Where the top bar passes a click on to the app, the click opens the
    // window. Where it opens the menu instead, the menu's first item does.
    this.tray.on("click", () => this.actions.open());
    this.showMenu();
  }

  /** Changes the menu's line about the phone link. */
  update(status: string): void {
    if (status === this.status || this.tray.isDestroyed()) return;
    this.status = status;
    this.showMenu();
  }

  /** Takes the icon out of the top bar. */
  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }

  private showMenu(): void {
    const items: MenuItemConstructorOptions[] = [
      { label: "Open Schema Studio", click: () => this.actions.open() },
      // A line to read, not to click.
      { label: this.status, enabled: false },
      { type: "separator" },
      { label: "Quit Schema Studio", click: () => this.actions.quit() },
    ];
    // Linux only shows a changed menu once it is set again, so the whole
    // menu is built afresh each time.
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }
}
