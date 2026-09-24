// Shadow-DOM styles for floating and inline widgets.
//
// Per-mode frame sizing:
//  - default (collapsed pill): 168×224 desktop, 96×128 mobile.
//  - .mode-text / .mode-audio / .mode-video: 320×~427 desktop, 280×~373 mobile.
//  - .mode-min (minimized live call): 132×176 desktop, 108×144 mobile.
//  - Mobile text escapes its corner and goes edge-to-edge fullscreen.

import type { EmbedAnchor } from "../protocol"

export interface AnchorEdges {
  isTop: boolean
  isLeft: boolean
}

export function anchorEdges(anchor: EmbedAnchor): AnchorEdges {
  return { isTop: anchor.startsWith("top"), isLeft: anchor.includes("left") }
}

function bubbleRadius(isTop: boolean, isLeft: boolean): string {
  const tl = isTop && isLeft ? 6 : 16
  const tr = isTop && !isLeft ? 6 : 16
  const br = !isTop && !isLeft ? 6 : 16
  const bl = !isTop && isLeft ? 6 : 16
  return `${tl}px ${tr}px ${br}px ${bl}px`
}

/** Fixed-position host box pinning the widget to one viewport corner. */
export function floatingHostCss(anchor: EmbedAnchor): string {
  const { isTop, isLeft } = anchorEdges(anchor)
  return `position:fixed;${isTop ? "top" : "bottom"}:16px;${isLeft ? "left" : "right"}:16px;z-index:2147483000;pointer-events:none`
}

/** The `<style>` text for the floating widget's shadow root. */
export function floatingShadowCss(anchor: EmbedAnchor): string {
  const { isTop, isLeft } = anchorEdges(anchor)
  const align = isLeft ? "flex-start" : "flex-end"
  const edgeY = isTop ? "top" : "bottom"
  const edgeX = isLeft ? "left" : "right"
  return `.lk-wrap{display:flex;flex-direction:column;align-items:${align};gap:8px;pointer-events:none}.lk-frame{width:168px;aspect-ratio:3/4;border:0;border-radius:24px;background:transparent;box-shadow:0 14px 44px -10px rgba(0,0,0,.42);pointer-events:auto;transition:width .28s cubic-bezier(.4,0,.2,1),height .28s cubic-bezier(.4,0,.2,1)}.lk-frame.mode-text,.lk-frame.mode-audio,.lk-frame.mode-video{width:320px;max-width:calc(100vw - 32px)}.lk-frame.mode-min{width:132px}@media (max-width:639px){.lk-frame{width:96px}.lk-frame.mode-text,.lk-frame.mode-audio,.lk-frame.mode-video{width:280px}.lk-frame.mode-min{width:108px}.lk-frame.mode-text{position:fixed;${edgeY}:0;${edgeX}:0;width:100vw;height:100dvh;aspect-ratio:auto;border-radius:0;box-shadow:none;max-width:none;max-height:none}}.lk-bubble{appearance:none;border:0;text-align:left;width:max-content;max-width:min(240px,calc(100vw - 32px));box-sizing:border-box;background:#fff;color:#111;font:500 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:9px 13px;border-radius:${bubbleRadius(isTop, isLeft)};box-shadow:0 10px 34px -8px rgba(0,0,0,.28);cursor:pointer;pointer-events:auto;transition:opacity .4s ease}.lk-powered{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:28px;font:500 10px/26px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:-.01em;color:rgba(0,0,0,.3);white-space:nowrap;pointer-events:auto}.lk-powered a{color:inherit;text-decoration:underline;text-underline-offset:2px}`
}

/** The `<style>` text for the inline widget's shadow root (no corner anchoring). */
export function inlineShadowCss(): string {
  return `.lk-wrap{display:block;width:100%;max-width:360px}.lk-frame{display:block;width:100%;aspect-ratio:3/4;border:0;border-radius:24px;box-shadow:0 14px 44px -10px rgba(0,0,0,.42);background:transparent}.lk-powered{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:28px;font:500 10px/26px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:-.01em;color:rgba(0,0,0,.3);white-space:nowrap}.lk-powered a{color:inherit;text-decoration:underline;text-underline-offset:2px}`
}

export const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-forms"
