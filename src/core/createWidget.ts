// The vanilla host controller. Owns the `/embed/<token>` iframe, the shadow-DOM
// chrome (teaser, "Powered by", positioning, optional drag), and the imperative
// API — over the shared headless transport (handshake + typed events live in
// `transport.ts`). The runtime UI itself lives in the iframe.

import { embedUrlFor, type ChatMode, type EmbedAnchor } from "../protocol"
import { attachDragHarness, type DragHandle } from "../drag"
import { scriptOrigin } from "./origin"
import { createTransport } from "./transport"
import {
  anchorEdges,
  floatingHostCss,
  floatingShadowCss,
  inlineShadowCss,
  IFRAME_SANDBOX,
} from "./styles"
import type { ChatMode as Mode, WidgetConfig, Widget } from "./types"

const ALL_MODES: ChatMode[] = ["text", "audio", "video"]
const TEASER_TTL = 5000

function resolveTarget(target: WidgetConfig["target"]): HTMLElement | null {
  if (!target) return null
  if (typeof target === "string") return document.querySelector<HTMLElement>(target)
  return target
}

export function createWidget(config: WidgetConfig): Widget {
  if (!config.token) throw new Error("[lookalike] createWidget: `token` is required")

  let cfg: WidgetConfig = { ...config }
  const origin = scriptOrigin(cfg.origin)
  const brandUrl = new URL(cfg.brandHref ?? origin, origin)
  if (brandUrl.protocol !== "https:" && brandUrl.protocol !== "http:") {
    throw new Error("[lookalike] brandHref must be an HTTP(S) URL")
  }
  const modes = cfg.modes && cfg.modes.length > 0 ? cfg.modes : ALL_MODES
  const needsMic = modes.includes("audio") || modes.includes("video")
  const embedUrl = embedUrlFor(cfg.token, origin, modes)
  const position = cfg.position ?? "floating"
  const inline = position === "inline"
  let anchor: EmbedAnchor = cfg.anchor ?? "bottom-right"
  let clientTools = { ...(cfg.clientTools ?? {}) }

  // ── DOM ────────────────────────────────────────────────────────────────────
  const host = document.createElement("div")
  host.setAttribute("data-lookalike-host", "")
  const root = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = inline ? inlineShadowCss() : floatingShadowCss(anchor)
  root.appendChild(style)

  const wrap = document.createElement("div")
  wrap.className = "lk-wrap"

  const frame = document.createElement("iframe")
  frame.className = "lk-frame"
  frame.title = "Lookalike conversation"
  frame.src = embedUrl
  frame.setAttribute("sandbox", IFRAME_SANDBOX)
  if (needsMic) frame.allow = "microphone; autoplay"

  const powered = document.createElement("div")
  powered.className = "lk-powered"
  const brandLink = document.createElement("a")
  brandLink.href = brandUrl.href
  brandLink.target = "_blank"
  brandLink.rel = "noopener noreferrer"
  brandLink.textContent = "Lookalike"
  powered.append("Powered by\u00a0", brandLink)

  const bubble = document.createElement("button")
  bubble.type = "button"
  bubble.className = "lk-bubble"
  bubble.style.display = "none"

  if (inline) {
    wrap.append(frame, powered)
  } else {
    const { isTop } = anchorEdges(anchor)
    if (isTop) wrap.append(frame, powered, bubble)
    else wrap.append(bubble, frame, powered)
  }
  root.appendChild(wrap)

  const mountTarget = resolveTarget(cfg.target)
  if (inline) {
    ;(mountTarget ?? document.body).appendChild(host)
  } else {
    host.style.cssText = floatingHostCss(anchor)
    document.body.appendChild(host)
  }

  // ── State ────────────────────────────────────────────────────────────────────
  let greeting = ""
  let opened = false
  let teased = false
  let mode: ChatMode | null = null
  let minimized = false
  let teaserTimer: ReturnType<typeof setTimeout> | null = null
  let drag: DragHandle | null = null
  let destroyed = false

  // Tracked timeouts so destroy() can clear every pending callback (otherwise a
  // teaser fade/auto-hide could fire against a detached node after teardown).
  const timers = new Set<ReturnType<typeof setTimeout>>()
  function later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
    return t
  }

  const mqNarrow =
    typeof window !== "undefined" ? window.matchMedia("(max-width: 639px)") : null

  // ── Teaser ────────────────────────────────────────────────────────────────────
  function hideTeaser() {
    if (bubble.style.display === "none") return
    bubble.style.opacity = "0"
    later(() => {
      bubble.style.display = "none"
    }, 400)
  }
  function showTeaser() {
    if (teased || opened || inline) return
    const text = cfg.teaser?.text?.trim() || greeting
    if (!text) return
    bubble.textContent = text
    bubble.style.display = ""
    bubble.style.opacity = "1"
    teased = true
    later(hideTeaser, TEASER_TTL)
  }

  // ── Transport (shared handshake + typed events) ──────────────────────────────
  function pushFullscreen() {
    if (inline) return
    const fs = !!mqNarrow?.matches && mode === "text" && !minimized
    transport.setFullscreen(fs)
  }

  function reskinForAnchor(next: EmbedAnchor) {
    if (next === anchor) return
    anchor = next
    style.textContent = floatingShadowCss(anchor)
  }

  const transport = createTransport({
    getFrame: () => frame,
    clientTools: () => clientTools,
    onGreeting: (text) => {
      greeting = text
    },
    onReady: () => {
      if (cfg.theme) transport.send("set-theme", { tokens: cfg.theme })
      if (cfg.overrides) transport.send("set-overrides", { overrides: cfg.overrides })
      if (cfg.teaser?.delaySeconds != null) {
        if (teaserTimer) clearTimeout(teaserTimer)
        teaserTimer = setTimeout(showTeaser, cfg.teaser.delaySeconds * 1000)
      }
    },
    onResize: ({ collapsed, mode: m, minimized: min, brand }) => {
      mode = collapsed ? null : m
      minimized = min
      let cls = "lk-frame"
      if (!collapsed) {
        if (minimized) cls += " mode-min"
        else if (mode) cls += " mode-" + mode
      }
      frame.className = cls
      powered.style.display = brand ? "flex" : "none"
      if (!collapsed) {
        opened = true
        hideTeaser()
      }
      pushFullscreen()
    },
    onDrag: (kind, s) => {
      if (!drag) return
      if (kind === "start" && s) drag.beginDrag(s.screenX, s.screenY, s.t)
      else if (kind === "update" && s) drag.updateDrag(s.screenX, s.screenY, s.t)
      else if (kind === "end") drag.endDrag()
    },
  })

  bubble.addEventListener("click", () => transport.send("expand"))
  mqNarrow?.addEventListener("change", pushFullscreen)

  // ── Drag (floating) ──────────────────────────────────────────────────
  if (!inline && cfg.draggable !== false) {
    drag = attachDragHarness({
      target: host,
      container: "viewport",
      initialAnchor: anchor,
      onAnchorChange: (a) => {
        if (a === "left-peek" || a === "right-peek") return
        reskinForAnchor(a)
      },
    })
  }

  // Click off a live widget → minimize to the corner pill (session keeps running).
  const onOutsidePointer = (e: PointerEvent) => {
    if (!opened || minimized || !mode || inline) return
    const path = e.composedPath ? e.composedPath() : []
    if (path.indexOf(host) >= 0 || host.contains(e.target as Node)) return
    transport.send("minimize")
  }
  if (!inline && typeof document !== "undefined") {
    document.addEventListener("pointerdown", onOutsidePointer, true)
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  const widget: Widget = {
    on: (type, cb) => transport.emitter.on(type, cb),
    off: (type, cb) => transport.emitter.off(type, cb),
    start: (m?: Mode) => (m ? transport.send("start-session", { mode: m }) : transport.send("expand")),
    stop: () => transport.send("end-session"),
    sendMessage: (text: string) => transport.send("send-text", { text }),
    injectContext: (text: string) => transport.send("inject-context", { text }),
    speak: (text: string) => transport.send("speak", { text }),
    setMode: (m: Mode) => transport.send("set-mode", { mode: m }),
    setMuted: (muted: boolean) => transport.send("set-muted", { muted }),
    expand: () => transport.send("expand"),
    minimize: () => transport.send("minimize"),
    open: () => transport.send("expand"),
    close: () => transport.send("end-session"),
    resolveTool: (id, result, error) => transport.send("tool-result", { id, result, error }),
    update: (partial) => {
      cfg = { ...cfg, ...partial }
      if ("clientTools" in partial) {
        clientTools = partial.clientTools ? { ...clientTools, ...partial.clientTools } : {}
        transport.syncClientTools()
      }
      if ("theme" in partial) transport.send("set-theme", { tokens: partial.theme ?? {} })
      if (partial.overrides) transport.send("set-overrides", { overrides: partial.overrides })
      if (partial.teaser?.text != null) bubble.textContent = partial.teaser.text
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      if (!inline) document.removeEventListener("pointerdown", onOutsidePointer, true)
      mqNarrow?.removeEventListener("change", pushFullscreen)
      if (teaserTimer) clearTimeout(teaserTimer)
      timers.forEach(clearTimeout)
      timers.clear()
      drag?.destroy()
      transport.destroy()
      host.remove()
    },
  }
  return widget
}
