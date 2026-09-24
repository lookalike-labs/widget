// Registers the Web Component and window.Lookalike command API.
// Calls buffered by a page's Lookalike.q shim are replayed after loading.

import { resolveAndCreateWidget } from "./core/config"
import "./element"
import type { Widget, WidgetConfig } from "./core/types"

const DEFAULT_NS = "default"

// Widget creation is deferred by a microtask, so each namespace holds
// the widget once ready plus a queue of actions buffered until then.
// `cancelled` covers the init/shutdown races: a re-init or shutdown while the
// first init is pending marks the old instance so its widget
// is destroyed the moment it materializes instead of mounting as an orphan.
interface Instance {
  widget: Widget | null
  pending: Array<(w: Widget) => void>
  cancelled: boolean
  controller?: AbortController
}
const instances = new Map<string, Instance>()

// Queue-shim contract: calls may arrive in any order before `init` (that is
// the whole point of the buffering snippet), so referencing a namespace that
// doesn't exist yet creates a buffering stub that `init` later adopts.
function instanceFor(ns: string): Instance {
  let inst = instances.get(ns)
  if (!inst) {
    inst = { widget: null, pending: [], cancelled: false }
    instances.set(ns, inst)
  }
  return inst
}

type InitArgs = WidgetConfig & { namespace?: string }
type OnArgs = { event: string; callback: (...a: unknown[]) => void; namespace?: string }

interface LookalikeGlobal {
  (method: string, ...args: unknown[]): void
  q?: IArguments[]
}

function nsOf(arg: unknown): string {
  return arg && typeof arg === "object" && "namespace" in arg && typeof (arg as { namespace?: unknown }).namespace === "string"
    ? (arg as { namespace: string }).namespace
    : DEFAULT_NS
}

function withWidget(ns: string, fn: (w: Widget) => void): void {
  const inst = instanceFor(ns)
  if (inst.widget) fn(inst.widget)
  else inst.pending.push(fn)
}

function dispatch(method: string, ...args: unknown[]): void {
  switch (method) {
    case "init":
    case "boot": {
      const config = (args[0] ?? {}) as InitArgs
      const ns = config.namespace ?? DEFAULT_NS
      const prev = instances.get(ns)
      let carried: Array<(w: Widget) => void> = []
      if (prev) {
        // Cancel a still-pending previous init (its widget destroys on arrival
        // instead of stacking a duplicate), destroy a live one, and carry over
        // calls buffered before this init (`on` before `init` is supported).
        prev.cancelled = true
        prev.controller?.abort()
        prev.widget?.destroy()
        if (!prev.widget) carried = prev.pending
      }
      const controller = new AbortController()
      const inst: Instance = { widget: null, pending: carried, cancelled: false, controller }
      instances.set(ns, inst)
      void resolveAndCreateWidget(config, { signal: controller.signal }).then((w) => {
        if (inst.cancelled) {
          w.destroy()
          return
        }
        inst.widget = w
        const queued = inst.pending
        inst.pending = []
        queued.forEach((fn) => fn(w))
      }).catch((error: unknown) => {
        if (inst.cancelled) return
        const detail = error instanceof Error ? error : new Error(String(error))
        inst.pending = []
        window.dispatchEvent(new CustomEvent("lookalike:error", { detail }))
      })
      return
    }
    case "update": {
      const partial = (args[0] ?? {}) as Partial<InitArgs>
      withWidget(nsOf(partial), (w) => w.update(partial))
      return
    }
    case "on": {
      const { event, callback, namespace } = (args[0] ?? {}) as OnArgs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      withWidget(namespace ?? DEFAULT_NS, (w) => w.on(event as any, callback as any))
      return
    }
    case "shutdown":
    case "destroy": {
      const ns = nsOf(args[0])
      const inst = instances.get(ns)
      if (inst) {
        inst.cancelled = true // a pending init's widget destroys on arrival
        inst.controller?.abort()
        inst.widget?.destroy()
      }
      instances.delete(ns)
      return
    }
    default: {
      // Method passthrough on the default instance: start/stop/sendMessage/…
      withWidget(DEFAULT_NS, (w) => {
        const fn = (w as unknown as Record<string, (...a: unknown[]) => void>)[method]
        if (typeof fn === "function") fn.apply(w, args)
        else console.warn(`[lookalike] unknown method: ${method}`)
      })
    }
  }
}

function install() {
  if (typeof window === "undefined") return
  const w = window as unknown as { Lookalike?: LookalikeGlobal }
  const queued = w.Lookalike?.q ?? []
  const real = ((method: string, ...args: unknown[]) => dispatch(method, ...args)) as LookalikeGlobal
  w.Lookalike = real
  for (const call of queued) {
    const [method, ...args] = Array.from(call) as [string, ...unknown[]]
    dispatch(method, ...args)
  }
}

install()
