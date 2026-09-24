// Standalone draggable harness for the lookalike widget. The widget (inside
// the iframe) owns pointer detection — it knows which DOM is a button and
// which is chrome, so it can differentiate tap from drag natively and let
// hover/touch UI work normally. The harness is the position controller: the
// integrator forwards the widget's drag events (over postMessage in
// production) into beginDrag / updateDrag / endDrag, and the harness handles
// anchor selection and the damped-spring settle.
//
// Behaviour: 4 corner anchors + 2 side "peek" dock states (left/right only —
// no top/bottom hide, matching FaceTime PiP). Peek requires intent: the
// release position must already be past the corner snap line for that side,
// so a quick flick from mid-screen lands on the corner, not docked offscreen.
// Closed-form damped spring carries release velocity into the motion (no
// canned tween — drag and settle read as one continuous gesture).

export type DragAnchor =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "left-peek"
  | "right-peek"

export interface AttachOptions {
  /** Positioned wrapper around the iframe. The harness transforms this. */
  target: HTMLElement
  /** Container the target is positioned within. "viewport" ⇒ visualViewport. */
  container?: HTMLElement | "viewport"
  /** Initial anchor. Default "bottom-right" (or persisted value). */
  initialAnchor?: DragAnchor
  /** Margin from container edges for corner anchors, px. Default 16. */
  margin?: number
  /** Spring angular frequency ω₀ in rad/s. Default 22. */
  stiffness?: number
  /** Damping ratio ζ. Clamped to (0.05, 0.99). Default 0.92. */
  damping?: number
  /** Momentum projection time-constant τ in seconds. Default 0.35. */
  decayTau?: number
  /** localStorage key for anchor persistence. Omit to disable. */
  persistKey?: string
  /** Notified when the widget settles at a new anchor. */
  onAnchorChange?: (anchor: DragAnchor) => void
  /**
   * Reports per-side peek progress (0 at corner snap, 1 at peek snap) on every
   * position update. The host renders the indicator as a child of the widget
   * wrapper, so it's already aligned vertically — no centreY needed.
   */
  onPeekProgress?: (progress: { left: number; right: number }) => void
}

export interface DragHandle {
  /** Toggle whether drag input is accepted. Disabling cancels any in-flight drag. */
  setEnabled(enabled: boolean): void
  /** Move to an anchor. animate=true springs there; false snaps. */
  setAnchor(anchor: DragAnchor, animate?: boolean): void
  /** Spring to the nearest on-screen corner from the current position. */
  snapToNearestCorner(): void
  getAnchor(): DragAnchor
  /** Re-apply the current anchor (after container resize, etc). */
  reanchor(): void
  /** Start a drag. Coords are absolute (screen-space, stable across translates). */
  beginDrag(screenX: number, screenY: number, timeMs: number): void
  /** Move the widget by the delta from the begin point. */
  updateDrag(screenX: number, screenY: number, timeMs: number): void
  /** Release: estimate velocity from the recent updates, project, settle. */
  endDrag(): void
  /** Abort: spring back to current anchor with zero velocity. */
  cancelDrag(): void
  destroy(): void
}

interface Vec2 {
  x: number
  y: number
}

interface VelocitySample {
  t: number
  x: number
  y: number
}

/**
 * Rendered width of the peek indicator at full emergence, in CSS px. The
 * harness uses this to size the progress ramp (span = 2*PEEK_WIDTH) so that
 * drag-by-peek tracks the pointer cleanly. Host renderers should use this
 * same constant for the indicator's max width.
 */
export const PEEK_WIDTH = 40

const ALL_ANCHORS: readonly DragAnchor[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "left-peek",
  "right-peek",
] as const

function isAnchor(value: unknown): value is DragAnchor {
  return typeof value === "string" && (ALL_ANCHORS as readonly string[]).includes(value)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function attachDragHarness(opts: AttachOptions): DragHandle {
  const target = opts.target
  const container = opts.container ?? "viewport"
  const margin = opts.margin ?? 16
  const omega0 = opts.stiffness ?? 22
  const zeta = clamp(opts.damping ?? 0.92, 0.05, 0.99)
  const tau = opts.decayTau ?? 0.35
  const persistKey = opts.persistKey
  const onAnchorChange = opts.onAnchorChange
  const onPeekProgress = opts.onPeekProgress

  // Persisted anchor wins over initialAnchor so the widget reopens where it
  // was last left. Validate the stored string before trusting it.
  const persisted = persistKey ? readPersistedAnchor(persistKey) : null
  let anchor: DragAnchor = persisted ?? opts.initialAnchor ?? "bottom-right"

  const prevUserSelect = target.style.userSelect
  const prevTouchAction = target.style.touchAction
  target.style.userSelect = "none"
  // Prevent parent-page scroll/zoom when touching the iframe wrapper on
  // mobile — without this, a touch-drag on the widget pans the page too.
  target.style.touchAction = "none"

  // Position is held in container-space pixels (top-left of target). Drive
  // visuals via transform only — transform doesn't trigger layout on the
  // host page, keeps the widget at 60fps, and composes cleanly with the
  // iframe's own width/height transitions.
  let pos: Vec2 = { x: 0, y: 0 }
  let vel: Vec2 = { x: 0, y: 0 }
  // Container-space top-left of the CSS-anchored box (before transform). Only
  // changes with anchor / widget size / container size, so it's cached and
  // recomputed at those points instead of measured every frame — applyTransform
  // (per drag-move and per settle tick) stays layout-read-free.
  let cssBase: Vec2 = { x: 0, y: 0 }

  type Mode = "idle" | "dragging" | "settling"
  let mode: Mode = "idle"
  let enabled = true

  let spring: {
    startTime: number
    target: Vec2
    d0: Vec2
    v0: Vec2
  } | null = null
  let rafId: number | null = null

  // Velocity sampling. updateDrag pushes screen-space samples; on release we
  // do a least-squares slope over the last ~60ms — single last-two-points is
  // too noisy. velSamples are in widget-position space (we've already done
  // the screen→pos delta), so the velocity is in px/s of widget movement.
  const velSamples: VelocitySample[] = []
  const VEL_WINDOW_MS = 60

  let dragStartPos: Vec2 = { x: 0, y: 0 }
  let dragStartScreen: Vec2 = { x: 0, y: 0 }

  function getContainerRect(): { w: number; h: number } {
    if (container === "viewport") {
      const vv = window.visualViewport
      return {
        w: vv?.width ?? window.innerWidth,
        h: vv?.height ?? window.innerHeight,
      }
    }
    const r = container.getBoundingClientRect()
    return { w: r.width, h: r.height }
  }

  function getWidgetSize(): { w: number; h: number } {
    const r = target.getBoundingClientRect()
    return { w: r.width, h: r.height }
  }

  // Resolve an anchor to container-space pixels. Peek anchors keep the
  // perpendicular axis of the current position so the widget docks "where
  // you left it" along the edge. Peek docks the widget flush off the edge
  // (inner edge of widget exactly at the container edge) — the peek
  // indicator emerging from the widget is the only visible affordance.
  function anchorToPosition(a: DragAnchor, current: Vec2): Vec2 {
    const c = getContainerRect()
    const w = getWidgetSize()
    const cornerX = (left: boolean) => (left ? margin : c.w - w.w - margin)
    const cornerY = (top: boolean) => (top ? margin : c.h - w.h - margin)
    const peekX = (left: boolean) => (left ? -w.w : c.w)
    const clampY = clamp(current.y, margin, Math.max(margin, c.h - w.h - margin))
    switch (a) {
      case "top-left":
        return { x: cornerX(true), y: cornerY(true) }
      case "top-right":
        return { x: cornerX(false), y: cornerY(true) }
      case "bottom-left":
        return { x: cornerX(true), y: cornerY(false) }
      case "bottom-right":
        return { x: cornerX(false), y: cornerY(false) }
      case "left-peek":
        return { x: peekX(true), y: clampY }
      case "right-peek":
        return { x: peekX(false), y: clampY }
    }
  }

  // Pick the snap target. Peek (side-dock) is only allowed when the *release
  // position* is already past the corresponding corner snap line — i.e., the
  // user intentionally dragged past where the widget would normally settle.
  // Without that gate, a quick flick from mid-screen could fling it offscreen,
  // which feels accidental. Given the gate is met, projection then decides
  // peek vs corner (corner if release momentum wouldn't fully clear the edge).
  function pickAnchor(): DragAnchor {
    const c = getContainerRect()
    const w = getWidgetSize()
    const leftSnapX = margin
    const rightSnapX = Math.max(margin, c.w - w.w - margin)
    const leftPeekX = -w.w
    const rightPeekX = c.w
    const projX = pos.x + vel.x * tau
    const projY = pos.y + vel.y * tau
    const projCx = projX + w.w / 2
    const projCy = projY + w.h / 2
    const top = projCy < c.h / 2

    // Peek requires intent: release must be past the corner snap line, and
    // projection must clear the midpoint between corner and peek.
    if (pos.x < leftSnapX && projX < (leftSnapX + leftPeekX) / 2) return "left-peek"
    if (pos.x > rightSnapX && projX > (rightSnapX + rightPeekX) / 2) return "right-peek"

    const left = projCx < c.w / 2
    return left ? (top ? "top-left" : "bottom-left") : top ? "top-right" : "bottom-right"
  }

  // The wrapper is CSS-anchored to its resting corner (the two edges nearest
  // that corner pinned to 0) so width/height transitions grow *from* that
  // corner — exactly like the non-draggable CSS layout. `transform` then only
  // carries the offset from that corner. The upshot: at rest the transform is
  // size-invariant (e.g. always (-margin, -margin) for bottom-right), so a
  // ResizeObserver that lags the size transition can't make the corner drift —
  // the corner pinning is done by CSS, not by chasing the size with transform.
  // Peek docks keep a top-left base (they're positioned fully off-edge via the
  // transform, where size-invariance doesn't matter).
  function anchorEdges(): { isLeft: boolean; isTop: boolean } {
    const isLeft =
      anchor === "top-left" || anchor === "bottom-left" || anchor === "left-peek" || anchor === "right-peek"
    const isTop =
      anchor === "top-left" || anchor === "top-right" || anchor === "left-peek" || anchor === "right-peek"
    return { isLeft, isTop }
  }

  // The resting inset of the anchored corner edges. Corners hold the margin
  // here (so transform is 0 at rest and stays purely the drag offset — never
  // transitioned, and free to melt the margin via the inset transition on
  // fullscreen); peek docks sit flush off-edge, so 0.
  function restingInset(): number {
    return anchor === "left-peek" || anchor === "right-peek" ? 0 : margin
  }

  function applyAnchorInset() {
    const { isLeft, isTop } = anchorEdges()
    const m = `${restingInset()}px`
    // 'auto' (not '') so we override the wrapper's default left-0/top-0 class.
    target.style.left = isLeft ? m : "auto"
    target.style.top = isTop ? m : "auto"
    target.style.right = isLeft ? "auto" : m
    target.style.bottom = isTop ? "auto" : m
    recomputeCssBase()
  }

  function clearAnchorInset() {
    target.style.left = ""
    target.style.top = ""
    target.style.right = ""
    target.style.bottom = ""
  }

  // Recompute the CSS-anchored box's container-space top-left, so
  // transform = pos − cssBase places the box's visual top-left at `pos`
  // regardless of which corner is pinned. Mirrors the resting inset so that at
  // rest pos === cssBase and the transform is 0. Called on anchor / size /
  // container change — never per frame.
  function recomputeCssBase() {
    const { isLeft, isTop } = anchorEdges()
    const m = restingInset()
    const c = getContainerRect()
    const w = getWidgetSize()
    cssBase = { x: isLeft ? m : c.w - w.w - m, y: isTop ? m : c.h - w.h - m }
  }

  function applyTransform() {
    target.style.transform = `translate3d(${pos.x - cssBase.x}px, ${pos.y - cssBase.y}px, 0)`
    emitPeekProgress()
  }

  // Peek doesn't emerge until the widget is almost entirely offscreen, then
  // ramps linearly to full as the widget completes its slide off. The ramp
  // span is intentionally 2× the indicator's rendered width PEEK_WIDTH so
  // that — when the user drags the widget by the peek indicator — peek_w
  // shrinks at half the rate of widget motion (dpeek_w/dpos = -0.5). That
  // makes the equation `peek_outer_edge = pointer + grab_offset` solvable
  // with widget motion = 2× pointer motion in the ramp, so the grab point
  // smoothly slides from "on the peek" to "on the widget" as peek shrinks.
  function emitPeekProgress() {
    if (!onPeekProgress) return
    const c = getContainerRect()
    const w = getWidgetSize()
    const span = 2 * PEEK_WIDTH
    // Left: widget at peek when pos.x = -w.w; progress=0 when widget's right
    // edge is `span` px past the screen edge (i.e., almost entirely offscreen).
    const left = clamp((-w.w + span - pos.x) / span, 0, 1)
    // Right: widget at peek when pos.x = c.w; progress=0 when widget's left
    // edge is `span` px from the screen's right edge.
    const right = clamp((pos.x - (c.w - span)) / span, 0, 1)
    onPeekProgress({ left, right })
  }

  // Underdamped damped-harmonic-oscillator closed form. Per-axis evaluation:
  // d(t) = e^(-ζω₀t) · (d₀·cos(ω_d t) + C·sin(ω_d t))
  // where C = (v₀ + ζω₀·d₀) / ω_d, ω_d = ω₀·√(1-ζ²).
  // v(t) = e^(-ζω₀t) · ((-ζω₀·d₀ + C·ω_d)·cos(ω_d t)
  //                    + (-ζω₀·C - d₀·ω_d)·sin(ω_d t))
  // ζ is clamped below 1 so ω_d > 0 — the (rare) ζ=1 branch is well-approximated.
  const omegaD = omega0 * Math.sqrt(1 - zeta * zeta)
  function evalSpring(d0: number, v0: number, t: number): { d: number; v: number } {
    const decay = Math.exp(-zeta * omega0 * t)
    const c = (v0 + zeta * omega0 * d0) / omegaD
    const cos = Math.cos(omegaD * t)
    const sin = Math.sin(omegaD * t)
    const d = decay * (d0 * cos + c * sin)
    const v = decay * ((-zeta * omega0 * d0 + c * omegaD) * cos + (-zeta * omega0 * c - d0 * omegaD) * sin)
    return { d, v }
  }

  function tick(now: number) {
    rafId = null
    if (!spring || mode !== "settling") return
    const t = (now - spring.startTime) / 1000
    const sx = evalSpring(spring.d0.x, spring.v0.x, t)
    const sy = evalSpring(spring.d0.y, spring.v0.y, t)
    pos = { x: spring.target.x + sx.d, y: spring.target.y + sy.d }
    vel = { x: sx.v, y: sy.v }
    applyTransform()
    // Energy-based termination: stop when both position and velocity are
    // small. Position-alone is a bug — at the target with high velocity is
    // a pass-through, not a rest.
    const settled =
      Math.abs(sx.d) < 0.5 && Math.abs(sy.d) < 0.5 && Math.abs(sx.v) < 5 && Math.abs(sy.v) < 5
    if (settled) {
      pos = { ...spring.target }
      vel = { x: 0, y: 0 }
      applyTransform()
      spring = null
      mode = "idle"
      target.style.willChange = ""
      return
    }
    rafId = requestAnimationFrame(tick)
  }

  function startSpring(targetAnchor: DragAnchor) {
    // Re-anchor the CSS edge up front. transform is recomputed relative to the
    // new edge so the on-screen position is continuous across the switch, then
    // the spring carries `pos` to the corner.
    if (anchor !== targetAnchor) {
      anchor = targetAnchor
      applyAnchorInset()
      applyTransform()
      if (persistKey) writePersistedAnchor(persistKey, anchor)
      onAnchorChange?.(anchor)
    }
    const targetPos = anchorToPosition(targetAnchor, pos)
    spring = {
      startTime: performance.now(),
      target: targetPos,
      d0: { x: pos.x - targetPos.x, y: pos.y - targetPos.y },
      v0: { x: vel.x, y: vel.y },
    }
    mode = "settling"
    target.style.willChange = "transform"
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(tick)
  }

  function cancelSpring() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    spring = null
  }

  // Least-squares slope of recent samples → px/s. Falls back to last-two
  // diff if only one prior sample; zero if none.
  function estimateVelocity(): Vec2 {
    if (velSamples.length < 2) return { x: 0, y: 0 }
    const n = velSamples.length
    let sumT = 0,
      sumX = 0,
      sumY = 0,
      sumTT = 0,
      sumTX = 0,
      sumTY = 0
    for (const s of velSamples) {
      sumT += s.t
      sumX += s.x
      sumY += s.y
      sumTT += s.t * s.t
      sumTX += s.t * s.x
      sumTY += s.t * s.y
    }
    const denom = n * sumTT - sumT * sumT
    if (Math.abs(denom) < 1e-6) return { x: 0, y: 0 }
    const mx = (n * sumTX - sumT * sumX) / denom
    const my = (n * sumTY - sumT * sumY) / denom
    // mx/my are px/ms; convert to px/s.
    return { x: mx * 1000, y: my * 1000 }
  }

  function pushVelSample(t: number, x: number, y: number) {
    velSamples.push({ t, x, y })
    const cutoff = t - VEL_WINDOW_MS
    while (velSamples.length > 0 && velSamples[0].t < cutoff) velSamples.shift()
    if (velSamples.length > 8) velSamples.shift()
  }

  function onResize() {
    if (mode === "dragging") return
    // While disabled (e.g. the widget has taken over the viewport in mobile
    // text fullscreen) we must NOT re-apply an anchor transform — a transform
    // on the fullscreen wrapper would offset it by the corner inset and break
    // the edge-to-edge layout. setEnabled(false) clears it; keep it cleared.
    if (!enabled) return
    cancelSpring()
    recomputeCssBase()
    pos = anchorToPosition(anchor, pos)
    vel = { x: 0, y: 0 }
    applyTransform()
  }

  window.addEventListener("resize", onResize)
  window.addEventListener("orientationchange", onResize)
  window.visualViewport?.addEventListener("resize", onResize)
  window.visualViewport?.addEventListener("scroll", onResize)

  let containerRO: ResizeObserver | null = null
  let targetRO: ResizeObserver | null = null
  if (typeof ResizeObserver !== "undefined") {
    targetRO = new ResizeObserver(onResize)
    targetRO.observe(target)
    if (container !== "viewport") {
      containerRO = new ResizeObserver(onResize)
      containerRO.observe(container)
    }
  }

  // Defer one frame so the target's intrinsic size is laid out before we
  // compute anchor positions.
  let initialRaf: number | null = requestAnimationFrame(() => {
    initialRaf = null
    applyAnchorInset()
    pos = anchorToPosition(anchor, pos)
    applyTransform()
  })


  return {
    setEnabled(value: boolean) {
      if (enabled === value) return
      enabled = value
      if (!enabled) {
        if (mode === "dragging") {
          // Snap back without velocity — a forced cancel shouldn't fling.
          vel = { x: 0, y: 0 }
          velSamples.length = 0
          startSpring(anchor)
        } else {
          // Fullscreen takeover (mobile text). Flush the anchored corner inset
          // to 0 (transform is already 0 at rest) so a wrapper sized to
          // 100vw/100dvh sits flush at the viewport edges. Because the wrapper
          // transitions its inset, the resting margin melts away as the size
          // grows — the widget grows out of its corner into fullscreen as one
          // motion instead of teleporting to inset-0 and then resizing.
          cancelSpring()
          const { isLeft, isTop } = anchorEdges()
          target.style.left = isLeft ? "0px" : "auto"
          target.style.top = isTop ? "0px" : "auto"
          target.style.right = isLeft ? "auto" : "0px"
          target.style.bottom = isTop ? "auto" : "0px"
          target.style.transform = "translate3d(0px, 0px, 0px)"
        }
      } else {
        // Re-enabled — restore the corner anchor and settle onto it.
        cancelSpring()
        applyAnchorInset()
        pos = anchorToPosition(anchor, pos)
        vel = { x: 0, y: 0 }
        applyTransform()
      }
    },
    setAnchor(a: DragAnchor, animate = true) {
      if (animate) {
        vel = { x: 0, y: 0 }
        startSpring(a)
      } else {
        cancelSpring()
        anchor = a
        applyAnchorInset()
        pos = anchorToPosition(a, pos)
        vel = { x: 0, y: 0 }
        applyTransform()
        if (persistKey) writePersistedAnchor(persistKey, a)
        onAnchorChange?.(a)
      }
    },
    snapToNearestCorner() {
      if (!enabled) return
      const c = getContainerRect()
      const w = getWidgetSize()
      const cx = pos.x + w.w / 2
      const cy = pos.y + w.h / 2
      const left = cx < c.w / 2
      const top = cy < c.h / 2
      const a: DragAnchor = left
        ? top ? "top-left" : "bottom-left"
        : top ? "top-right" : "bottom-right"
      vel = { x: 0, y: 0 }
      startSpring(a)
    },
    getAnchor() {
      return anchor
    },
    reanchor() {
      onResize()
    },
    beginDrag(screenX: number, screenY: number, timeMs: number) {
      if (!enabled) return
      // Interrupt any in-flight settle — pos/vel are already current from
      // the rAF loop, so we seed the new gesture from here.
      cancelSpring()
      mode = "dragging"
      target.style.willChange = "transform"
      dragStartPos = { ...pos }
      dragStartScreen = { x: screenX, y: screenY }
      velSamples.length = 0
      pushVelSample(timeMs, pos.x, pos.y)
    },
    updateDrag(screenX: number, screenY: number, timeMs: number) {
      if (!enabled || mode !== "dragging") return
      pos = {
        x: dragStartPos.x + (screenX - dragStartScreen.x),
        y: dragStartPos.y + (screenY - dragStartScreen.y),
      }
      applyTransform()
      pushVelSample(timeMs, pos.x, pos.y)
    },
    endDrag() {
      if (mode !== "dragging") return
      vel = estimateVelocity()
      velSamples.length = 0
      startSpring(pickAnchor())
    },
    cancelDrag() {
      if (mode !== "dragging") return
      vel = { x: 0, y: 0 }
      velSamples.length = 0
      startSpring(anchor)
    },
    destroy() {
      if (initialRaf !== null) {
        cancelAnimationFrame(initialRaf)
        initialRaf = null
      }
      cancelSpring()
      window.removeEventListener("resize", onResize)
      window.removeEventListener("orientationchange", onResize)
      window.visualViewport?.removeEventListener("resize", onResize)
      window.visualViewport?.removeEventListener("scroll", onResize)
      containerRO?.disconnect()
      targetRO?.disconnect()
      target.style.userSelect = prevUserSelect
      target.style.touchAction = prevTouchAction
      target.style.willChange = ""
      target.style.transform = ""
      clearAnchorInset()
    },
  }
}

function readPersistedAnchor(key: string): DragAnchor | null {
  try {
    const v = window.localStorage.getItem(key)
    return isAnchor(v) ? v : null
  } catch {
    return null
  }
}

function writePersistedAnchor(key: string, anchor: DragAnchor) {
  try {
    window.localStorage.setItem(key, anchor)
  } catch {}
}
