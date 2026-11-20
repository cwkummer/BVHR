/**
 * Runs async tasks strictly one after another per key (e.g. per battle id), so concurrent player
 * actions and alarm timeouts for the same battle can never interleave or double-apply.
 */
export class KeyedSerialQueue {
  private tails = new Map<string, Promise<void>>();

  /**
   * Queues `fn` behind any earlier task for `key` and resolves when it finishes. A failed earlier task
   * does not block later ones; `fn`'s own rejection propagates to its caller only.
   */
  async run(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const current = prev
      .catch(() => {
        // A failed prior task must not block subsequent serialized tasks.
      })
      .then(fn);

    this.tails.set(key, current);
    try {
      await current;
    } finally {
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }
}
