/**
 * The time, and timers, as the phone link's modules use them. Passed in, so
 * that tests can move time on by hand while the handshake and the encryption
 * they drive keep running for real.
 */
export type Clock = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

/** The computer's own clock. */
export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
