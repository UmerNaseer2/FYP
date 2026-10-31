/**
 * The relay's two small stores for short pairing codes, as Cloudflare runs
 * them: Durable Objects, each of which there is exactly one of for a name, so
 * two requests for the same name meet in one place whichever of Cloudflare's
 * machines they came in through. That is what makes "first to take it" and
 * "this many tries" exact rather than a guess per location. The rules are in
 * code-box-logic.ts, and the Worker (worker.ts) calls these from its door.
 */
import { DurableObject } from "cloudflare:workers";

import { countTry, storeBox, takeBox, TRIES_WINDOW_MS, type BoxStorage, type KeptBox, type Tries } from "./code-box-logic.js";

const KEPT = "kept";
const TRIES = "tries";

/** The box behind one label. The Worker names each after its label. */
export class CodeBox extends DurableObject {
  /** The object's own storage, in the words the rules use. */
  private readonly storage: BoxStorage = {
    get: () => this.ctx.storage.get<KeptBox>(KEPT),
    put: (kept) => this.ctx.storage.put(KEPT, kept),
    remove: async () => {
      await this.ctx.storage.delete(KEPT);
    },
    wakeAt: (time) => this.ctx.storage.setAlarm(time),
  };

  async store(box: Uint8Array): Promise<"stored" | "taken"> {
    return storeBox(this.storage, box, Date.now());
  }

  async take(): Promise<Uint8Array | null> {
    return takeBox(this.storage, Date.now());
  }

  /** Clears away a box nobody took. A newer box's alarm replaced any older one's, so this is always the newest box's time. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * How many times one address has used the door lately. The Worker names each
 * after the address. Only the count and the time are written here, and the
 * name is the only trace of the address, gone with the object once it is clear.
 */
export class CodeTries extends DurableObject {
  async allow(): Promise<boolean> {
    const now = Date.now();
    const { next, allowed } = countTry(await this.ctx.storage.get<Tries>(TRIES), now);
    await this.ctx.storage.put(TRIES, next);
    if (next.count === 1) await this.ctx.storage.setAlarm(now + TRIES_WINDOW_MS);
    return allowed;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
