// The drop-in `<lookalike-widget>` custom element. A thin declarative shell over
// `createWidget()`: HTML attributes → config, imperative methods on the element,
// and widget events re-dispatched as `bubbles/composed` DOM CustomEvents
// (`lookalike:connect`, `lookalike:message`, …) so they cross the shadow
// boundary and work in any framework.
//
// Rich values use properties. The optional `lookalike:call` event lets callers
// customize the resolved config immediately before the widget is created.

import { createWidget } from "./core/createWidget"
import { scriptOrigin } from "./core/origin"
import type {
  ChatMode,
  ClientTools,
  ThemeTokens,
  Widget,
  WidgetConfig,
  WidgetEvent,
  WidgetEventMap,
} from "./core/types"

const TAG = "lookalike-widget"

/** Native event payloads, shared by framework templates and DOM listeners. */
export type WidgetDOMEventMap = {
  [K in WidgetEvent as `lookalike:${K}`]: CustomEvent<WidgetEventMap[K][0]> & { readonly type: `lookalike:${K}` }
} & { "lookalike:call": CustomEvent<{ config: WidgetConfig }> & { readonly type: "lookalike:call" } }

export type WidgetDOMEvent = WidgetDOMEventMap[keyof WidgetDOMEventMap]

declare global {
  interface HTMLElementTagNameMap {
    // Public shape avoids nominal private-field conflicts when a project
    // consumes both ESM and CommonJS declarations.
    "lookalike-widget": Pick<LookalikeWidgetElement, keyof LookalikeWidgetElement>
  }
  interface HTMLElementEventMap extends WidgetDOMEventMap {}
}

// SSR-safe base. `HTMLElement` only exists in the browser, but this module is
// pulled into server bundles (the package's `.` entry re-exports it, and
// frameworks SSR-import it). Evaluating `class X extends HTMLElement` on the
// server would throw at module load, so fall back to a stub — the element is
// only ever defined/used client-side (guarded below).
const ElementBase: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement)

const FORWARDED_EVENTS: WidgetEvent[] = [
  "ready",
  "connect",
  "disconnect",
  "message",
  "transcript",
  "mode-change",
  "speaking-change",
  "resize",
  "tool-call",
  "error",
]

export const WIDGET_DOM_EVENTS: readonly (keyof WidgetDOMEventMap)[] = [
  "lookalike:call",
  ...FORWARDED_EVENTS.map((type): `lookalike:${WidgetEvent}` => `lookalike:${type}`),
]

// Changing any of these rebuilds the widget (they affect the iframe URL or the
// chrome structure). Soft props like teaser text update in place instead.
const STRUCTURAL_ATTRS = ["token", "origin", "modes", "position", "anchor", "draggable"]

function parseModes(raw: string | null): ChatMode[] | undefined {
  if (!raw) return undefined
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((m): m is ChatMode => m === "text" || m === "audio" || m === "video")
  return list.length ? list : undefined
}

export class LookalikeWidgetElement extends ElementBase {
  static get observedAttributes() {
    return [...STRUCTURAL_ATTRS, "teaser-text", "teaser-delay"]
  }

  private widget: Widget | null = null
  private mountAbort: AbortController | null = null
  private unbinders: Array<() => void> = []
  // Property-set values (not reflectable to attributes).
  private _clientTools?: ClientTools
  private _theme?: ThemeTokens

  connectedCallback() {
    this.mount()
  }

  disconnectedCallback() {
    this.teardown()
  }

  attributeChangedCallback(name: string, prev: string | null, next: string | null) {
    if (prev === next || !this.isConnected) return
    if (STRUCTURAL_ATTRS.includes(name)) {
      this.remount()
    } else if (name === "teaser-text") {
      this.widget?.update({ teaser: { text: next ?? "" } })
    } else if (name === "teaser-delay") {
      // The delay only matters at widget creation (it arms a one-shot timer),
      // so a live change needs a rebuild to take effect.
      this.remount()
    }
  }

  // Unspecified appearance fields use the SDK defaults, never saved preferences.
  private readConfig(): WidgetConfig {
    const position = this.getAttribute("position")
    const anchor = this.getAttribute("anchor")
    const teaserText = this.getAttribute("teaser-text") ?? undefined
    const teaserDelayRaw = this.getAttribute("teaser-delay")
    const teaserDelay = teaserDelayRaw != null ? Number(teaserDelayRaw) : undefined
    return {
      token: this.getAttribute("token") ?? "",
      origin: this.getAttribute("origin") ?? undefined,
      modes: parseModes(this.getAttribute("modes")),
      position: position === "inline" || position === "floating" ? position : undefined,
      anchor: anchor === "top-left" || anchor === "top-right" || anchor === "bottom-left" || anchor === "bottom-right" ? anchor : undefined,
      draggable: this.hasAttribute("draggable") ? this.getAttribute("draggable") !== "false" : undefined,
      teaser:
        teaserText != null || teaserDelay != null
          ? { text: teaserText, delaySeconds: Number.isFinite(teaserDelay) ? teaserDelay : undefined }
          : undefined,
      theme: this._theme,
      clientTools: this._clientTools,
    }
  }

  private async mount() {
    if (this.widget || this.mountAbort || !this.isConnected) return
    const initial = this.readConfig()
    if (!initial.token) return // nothing to do without a token
    const controller = new AbortController()
    this.mountAbort = controller
    try {
      // Let framework property setters and queued removals finish before mounting.
      await Promise.resolve()
      if (controller.signal.aborted || !this.isConnected) return

      const config = this.readConfig()
      config.origin = scriptOrigin(config.origin)
      config.target = config.position === "inline" ? this : undefined
      this.style.display = config.position === "inline" ? "block" : "contents"

      const callEvent = new CustomEvent("lookalike:call", {
        bubbles: true,
        composed: true,
        detail: { config },
      })
      this.dispatchEvent(callEvent)
      // A host listener can remove the element or change its token.
      if (controller.signal.aborted || !this.isConnected) return

      const widget = createWidget(callEvent.detail.config)
      this.widget = widget

      for (const type of FORWARDED_EVENTS) {
        const unbind = widget.on(type, (...args: WidgetEventMap[typeof type]) => {
          this.dispatchEvent(
            new CustomEvent(`lookalike:${type}`, {
              bubbles: true,
              composed: true,
              detail: args.length <= 1 ? args[0] : args,
            }),
          )
        })
        this.unbinders.push(unbind)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.dispatchEvent(new CustomEvent("lookalike:error", {
          bubbles: true,
          composed: true,
          detail: error instanceof Error ? error : new Error(String(error)),
        }))
      }
    } finally {
      if (this.mountAbort === controller) this.mountAbort = null
    }
  }

  private teardown() {
    this.mountAbort?.abort()
    this.mountAbort = null
    for (const u of this.unbinders) u()
    this.unbinders = []
    this.widget?.destroy()
    this.widget = null
  }

  private remount() {
    this.teardown()
    this.mount()
  }

  // ── Imperative API (delegates to the underlying widget) ──────────────────────
  get instance(): Widget | null {
    return this.widget
  }
  set clientTools(tools: ClientTools | undefined) {
    this._clientTools = tools
    // Property assignment replaces the tools, unlike the imperative merge API.
    this.widget?.update({ clientTools: undefined })
    this.widget?.update({ clientTools: tools })
  }
  set theme(tokens: ThemeTokens | undefined) {
    this._theme = tokens
    this.widget?.update({ theme: tokens })
  }
  start(mode?: ChatMode) {
    this.widget?.start(mode)
  }
  stop() {
    this.widget?.stop()
  }
  sendMessage(text: string) {
    this.widget?.sendMessage(text)
  }
  injectContext(text: string) {
    this.widget?.injectContext(text)
  }
  speak(text: string) {
    this.widget?.speak(text)
  }
  setMode(mode: ChatMode) {
    this.widget?.setMode(mode)
  }
  setMuted(muted: boolean) {
    this.widget?.setMuted(muted)
  }
  expand() {
    this.widget?.expand()
  }
  minimize() {
    this.widget?.minimize()
  }
  open() {
    this.widget?.open()
  }
  close() {
    this.widget?.close()
  }
  resolveTool(id: string, result: unknown, error?: string) {
    this.widget?.resolveTool(id, result, error)
  }
  update(partial: Partial<WidgetConfig>) {
    this.widget?.update(partial)
  }
}

/** Register `<lookalike-widget>` once (idempotent, SSR-safe). */
export function defineLookalikeWidget(): void {
  if (typeof customElements === "undefined") return
  if (!customElements.get(TAG)) customElements.define(TAG, LookalikeWidgetElement)
}

defineLookalikeWidget()
