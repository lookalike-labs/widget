// Minimal typed event emitter. `on()` returns an unsubscribe fn (nanoevents
// ergonomics). Backs both the imperative `.on()` API and the React hook.

export type EventArgs = Record<string, unknown[]>

export class Emitter<E extends EventArgs> {
  private map: { [K in keyof E]?: Set<(...args: E[K]) => void> } = {}

  on<K extends keyof E>(type: K, cb: (...args: E[K]) => void): () => void {
    const set = (this.map[type] ??= new Set())
    set.add(cb)
    return () => this.off(type, cb)
  }

  off<K extends keyof E>(type: K, cb: (...args: E[K]) => void): void {
    this.map[type]?.delete(cb)
  }

  emit<K extends keyof E>(type: K, ...args: E[K]): void {
    // Copy before iterating so a listener that unsubscribes mid-emit is safe.
    const set = this.map[type]
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(...args)
      } catch (err) {
        // A throwing listener must not break the emit loop or the transport.
        console.error("[lookalike] event listener threw", err)
      }
    }
  }

  clear(): void {
    this.map = {}
  }
}
