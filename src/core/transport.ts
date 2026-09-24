// Host–iframe messaging shared by the application and embedded widget.
// Handles the MessageChannel handshake, typed events, and commands.

import {
  command,
  PROTO_VERSION,
  HOST_INIT_CHANNEL,
  HOST_READY,
  HOST_FULLSCREEN,
  WIDGET_READY,
  WIDGET_RESIZE,
  WIDGET_GREETING,
  WIDGET_PAINTED,
  SESSION_START,
  SESSION_END,
  MESSAGE,
  QUESTION_TRANSCRIPTION,
  ANSWER_TRANSCRIPTION,
  RESPONSE_START,
  RESPONSE_END,
  TOOL_CALL,
  DRAG_START,
  DRAG_UPDATE,
  DRAG_END,
  type ChatMode,
  type CommandAction,
  type CommandMessage,
  type CommandPayloads,
} from "../protocol"
import { CLIENT_TOOLS, isClientToolName } from "../tools"
import { validateToolArguments } from "./tool-validation"
import { Emitter } from "./emitter"
import type { ClientTool, ClientTools, ClientToolWireSpec, WidgetEventMap } from "./types"

export interface ResizeState {
  collapsed: boolean
  mode: ChatMode | null
  minimized: boolean
  brand: boolean
}

export interface DragSignal {
  screenX: number
  screenY: number
  t: number
}

export interface TransportOptions {
  /** Resolve the live iframe element (re-read per event so it survives reloads). */
  getFrame: () => HTMLIFrameElement | null
  /** Host-page tools the avatar can call, keyed by name (defs or preset handlers). */
  clientTools?: () => ClientTools
  /** Frame size class changed. */
  onResize?: (state: ResizeState) => void
  /** Teaser greeting text arrived. */
  onGreeting?: (text: string) => void
  /** Collapsed avatar painted (reveal signal). */
  onPainted?: () => void
  /** Handshake complete. */
  onReady?: (version: string) => void
  /** Drag forwarded from inside the iframe. */
  onDrag?: (kind: "start" | "update" | "end", signal?: DragSignal) => void
}

export interface Transport {
  readonly emitter: Emitter<WidgetEventMap>
  send<A extends CommandAction>(action: A, payload?: CommandPayloads[A]): void
  setFullscreen(fullscreen: boolean): void
  /** Re-derive tool specs from `clientTools()` and push them to the iframe (call after config updates). */
  syncClientTools(): void
  /** Re-ping the iframe to (re)establish the channel (e.g. after a host remount). */
  ping(): void
  destroy(): void
}

/** The spec half of a `clientTools` entry: the def's own spec, or the preset
 *  spec for a bare handler registered under a preset name. */
function specOf(name: string, entry: ClientTools[string]): ClientToolWireSpec | null {
  if (typeof entry !== "function") return { description: entry.description, parameters: entry.parameters }
  if (isClientToolName(name)) return CLIENT_TOOLS[name]
  return null
}

/** The handler half of a `clientTools` entry. */
function handlerOf(entry: ClientTools[string] | undefined): ClientTool | null {
  if (!entry) return null
  return typeof entry === "function" ? entry : entry.handler
}

export function createTransport(opts: TransportOptions): Transport {
  const emitter = new Emitter<WidgetEventMap>()
  let port: MessagePort | null = null
  let instanceId: string | null = null
  let lastLiveMode: ChatMode | null = null
  let destroyed = false

  function frameWindow(): Window | null {
    return opts.getFrame()?.contentWindow ?? null
  }

  // Target the iframe's known origin (derived from its src) for host→iframe
  // posts, so commands + the MessageChannel port transfer can't be delivered to a
  // different origin if the frame is ever navigated away. Falls back to "*" only
  // if the src can't be parsed. (iframe→parent stays "*" — embedder origin is
  // unknown — guarded instead by the e.source === frameWindow() check.)
  function frameOrigin(): string {
    const src = opts.getFrame()?.src
    if (!src) return "*"
    try {
      return new URL(src, typeof location !== "undefined" ? location.href : undefined).origin
    } catch {
      return "*"
    }
  }

  // Commands sent before the handshake completes are buffered and flushed once
  // the port is live. A raw postMessage into a still-loading iframe is silently
  // lost (no document, no listener yet), which broke the documented
  // `Lookalike('init', …); Lookalike('start')` ordering. Queue-only (no
  // best-effort window post) so nothing can be delivered twice. Bounded so a
  // dead iframe can't grow it without limit.
  const prePortQueue: Array<CommandMessage> = []
  const MAX_QUEUED_COMMANDS = 64

  function send<A extends CommandAction>(action: A, payload?: CommandPayloads[A]) {
    if (destroyed) return
    const msg = command(action, payload)
    if (port) {
      port.postMessage(msg)
      return
    }
    if (prePortQueue.length < MAX_QUEUED_COMMANDS) prePortQueue.push(msg)
  }

  async function runClientTool(id: string, name: string, args: unknown) {
    const tools = opts.clientTools?.()
    const entry = tools && Object.hasOwn(tools, name) ? tools[name] : undefined
    const tool = handlerOf(entry)
    if (!tool) {
      emitter.emit("tool-call", { id, name, args })
      return
    }
    try {
      const spec = entry && specOf(name, entry)
      if (!spec) throw new Error(`Tool "${name}" has no parameter schema`)
      validateToolArguments(spec.parameters, args)
      const result = await tool(args)
      send("tool-result", { id, result })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      send("tool-result", { id, error: e.message })
      emitter.emit("error", e)
    }
  }

  // Push the LLM-facing specs into the iframe, which forwards them to the
  // server at session start. Bare handlers under non-preset names have no
  // schema to expose — warn once each and skip.
  const warnedNoSpec = new Set<string>()
  let specsSentOnce = false
  function syncClientTools() {
    const entries = opts.clientTools?.() ?? {}
    const tools: Record<string, ClientToolWireSpec> = {}
    for (const [name, entry] of Object.entries(entries)) {
      const spec = specOf(name, entry)
      if (spec) {
        tools[name] = spec
      } else if (!warnedNoSpec.has(name)) {
        warnedNoSpec.add(name)
        if (typeof console !== "undefined") {
          console.warn(
            `[lookalike] clientTools.${name} is a bare function but "${name}" is not a preset — ` +
              `pass { description, parameters, handler } so the avatar knows how to call it.`,
          )
        }
      }
    }
    // Nothing to declare and nothing previously declared ⇒ skip the message
    // entirely (the common no-tools embed stays two-message cheap).
    if (Object.keys(tools).length > 0 || specsSentOnce) {
      specsSentOnce = true
      send("set-client-tools", { tools })
    }
  }

  function onPortMessage(ev: MessageEvent) {
    if (destroyed) return
    const d = ev.data || {}
    switch (d.type) {
      case WIDGET_RESIZE: {
        const collapsed = !!d.collapsed
        const mode: ChatMode | null = collapsed ? null : (d.mode ?? null)
        const minimized = !collapsed && !!d.minimized
        const brand = "brand" in d ? !!d.brand : true
        opts.onResize?.({ collapsed, mode, minimized, brand })
        emitter.emit("resize", { collapsed, mode, minimized })
        if (mode && mode !== lastLiveMode) {
          lastLiveMode = mode
          emitter.emit("mode-change", mode)
        }
        break
      }
      case WIDGET_GREETING:
        opts.onGreeting?.(d.text || "")
        break
      case WIDGET_PAINTED:
        opts.onPainted?.()
        break
      case SESSION_START:
        emitter.emit("connect", { mode: (d.mode as ChatMode) ?? "text" })
        break
      case SESSION_END:
        lastLiveMode = null
        emitter.emit("disconnect")
        break
      case MESSAGE:
        if (d.role === "user" || d.role === "assistant")
          emitter.emit("message", { role: d.role, content: d.content ?? "" })
        break
      case QUESTION_TRANSCRIPTION:
      case ANSWER_TRANSCRIPTION:
        if (d.role === "user" || d.role === "assistant")
          emitter.emit("transcript", {
            role: d.role,
            content: d.content ?? "",
            messageId: typeof d.messageId === "string" ? d.messageId : "",
            timestamp: typeof d.timestamp === "number" ? d.timestamp : 0,
          })
        break
      case RESPONSE_START:
        emitter.emit("speaking-change", true)
        break
      case RESPONSE_END:
        emitter.emit("speaking-change", false)
        break
      case TOOL_CALL:
        void runClientTool(d.id, d.name, d.args)
        break
      case DRAG_START:
        if (typeof d.screenX === "number") opts.onDrag?.("start", { screenX: d.screenX, screenY: d.screenY, t: d.t })
        break
      case DRAG_UPDATE:
        if (typeof d.screenX === "number") opts.onDrag?.("update", { screenX: d.screenX, screenY: d.screenY, t: d.t })
        break
      case DRAG_END:
        opts.onDrag?.("end")
        break
    }
  }

  function establish(announcedId: string | null, version: string) {
    // One channel per embed document; a repeat ready with the same id is ignored
    // (avoids orphaning the live port), a reload (new id) rebuilds.
    if (port && instanceId === announcedId) return
    port?.close()
    instanceId = announcedId
    // Warn on a host/iframe protocol major-version mismatch (published package vs
    // deployed embed) — silent drift otherwise manifests as features quietly
    // failing.
    if (version.split(".")[0] !== PROTO_VERSION.split(".")[0]) {
      const e = new Error(`protocol version mismatch: host ${PROTO_VERSION}, iframe ${version}`)
      if (typeof console !== "undefined") console.warn(`[lookalike] ${e.message}`)
      emitter.emit("error", e)
    }
    const ch = new MessageChannel()
    port = ch.port1
    ch.port1.onmessage = onPortMessage
    frameWindow()?.postMessage({ type: HOST_INIT_CHANNEL }, frameOrigin(), [ch.port2])
    // Tool specs first, then the buffered backlog: a queued `start-session`
    // must find the declared tools already in place. (Re-establishes after an
    // iframe reload re-send too — the new document starts blank.)
    specsSentOnce = false
    syncClientTools()
    // Session configuration must arrive before an eagerly queued start/send.
    opts.onReady?.(version)
    while (prePortQueue.length) port?.postMessage(prePortQueue.shift())
    emitter.emit("ready", { version })
  }

  function onWindowMessage(e: MessageEvent) {
    if (destroyed) return
    if (e.source !== frameWindow()) return
    if (e.data?.type === WIDGET_PAINTED) {
      // Fallback path before the port is up — still reveal.
      opts.onPainted?.()
      return
    }
    if (e.data?.type !== WIDGET_READY) return
    const announced = typeof e.data.instanceId === "string" ? e.data.instanceId : null
    const version = typeof e.data.version === "string" ? e.data.version : PROTO_VERSION
    establish(announced, version)
  }

  window.addEventListener("message", onWindowMessage)
  function ping() {
    if (destroyed) return
    frameWindow()?.postMessage({ type: HOST_READY }, frameOrigin())
  }
  ping()

  return {
    emitter,
    send,
    setFullscreen: (fullscreen: boolean) => {
      port?.postMessage({ type: HOST_FULLSCREEN, fullscreen })
    },
    syncClientTools,
    ping,
    destroy: () => {
      if (destroyed) return
      destroyed = true
      window.removeEventListener("message", onWindowMessage)
      port?.close()
      port = null
      prePortQueue.length = 0
      emitter.clear()
    },
  }
}
