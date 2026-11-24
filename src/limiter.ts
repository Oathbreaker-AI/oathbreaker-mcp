// At most MCP_SLOTS_PER_KEY generations per API key at once through MCP, so an
// agent stuck in a loop cannot crowd out other customers. The account's own API
// limits still apply on top of this.

export type Release = () => Promise<void> | void;

export interface SlotLimiter {
  /** Returns a release function, or null when every slot is taken. */
  acquire(): Promise<Release | null>;
}

/** In-process slots, for the local stdio server (one process per user). */
export class LocalLimiter implements SlotLimiter {
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<Release | null> {
    if (this.running >= this.max) return null;
    this.running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
    };
  }
}

/** A limiter that never refuses; used where no key is present yet. */
export const unlimited: SlotLimiter = { acquire: async () => () => {} };
