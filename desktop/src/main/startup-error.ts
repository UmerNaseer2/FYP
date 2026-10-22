/**
 * A problem that stops Schema Studio from starting, written for the person
 * using it: a short title, and a message that says what to do next. The start
 * screen shows both word for word, with Try again, Open logs and Copy details
 * under them.
 *
 * Anything else thrown while starting is shown with a general title and
 * message instead (see DesktopApp's fail), so only problems the app
 * understands get specific advice. The cause, when there is one, goes to the
 * log, never to the screen.
 */
export class StartupError extends Error {
  readonly title: string;

  constructor(title: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StartupError";
    this.title = title;
  }
}
