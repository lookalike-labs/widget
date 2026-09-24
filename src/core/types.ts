import type { ChatMode, ClientToolWireSpec, EmbedAnchor, EmbedPosition, SessionOverrides, ThemeTokens } from "../protocol"
import type { ClientToolSpec } from "../tools"

export type { ChatMode, ClientToolWireSpec, EmbedAnchor, EmbedPosition, SessionOverrides, ThemeTokens }
export type { ClientToolSpec }

// A host-page function the avatar can invoke mid-conversation. The return
// value (or thrown error) is sent back to the agent as the tool result.
export type ClientTool = (args: unknown) => unknown | Promise<unknown>

// A fully-declared client tool: the LLM-facing spec plus the handler that runs
// in the host page. The spec is forwarded to the agent at session start; the
// handler never leaves the page.
export interface ClientToolDef extends ClientToolSpec {
  handler: ClientTool
}

// The `clientTools` config value. A bare function is shorthand for a preset —
// its spec is looked up in `@lookalike/widget/tools` by name (unknown names
// warn and are not exposed to the avatar).
export type ClientTools = Record<string, ClientTool | ClientToolDef>

export interface TeaserConfig {
  /** Bubble copy. Empty ⇒ fall back to the lookalike's server greeting. */
  text?: string
  /** Auto-flash the teaser this long after the widget is ready. Omit ⇒ no auto-show. */
  delaySeconds?: number
}

export interface WidgetConfig {
  /** Embed-link token from the dashboard Share tab. Required. */
  token: string
  /** Service origin. Defaults to the self-hosted loader's origin, otherwise https://lookalike.com. */
  origin?: string
  /** Chat modes to offer, best-first. Omit ⇒ all enabled for the embed. */
  modes?: ChatMode[]
  /** floating: pinned to a viewport corner. inline: dropped into `target`'s flow. */
  position?: EmbedPosition
  /** Resting corner for floating. Default "bottom-right". */
  anchor?: EmbedAnchor
  /** Allow dragging the floating widget between corners. Default true. */
  draggable?: boolean
  /** Teaser bubble. */
  teaser?: TeaserConfig
  /** Theme tokens forwarded into the iframe UI (CSS custom properties). */
  theme?: ThemeTokens
  /** Host-page tools the avatar can call: spec + handler per name (or a bare
   *  handler for a preset from `@lookalike/widget/tools`). Requires the embed
   *  link's "Client tools" permission. */
  clientTools?: ClientTools
  /** Per-session overrides (firstMessage / dynamicVariables / systemPromptAddition). */
  overrides?: SessionOverrides
  /** Where to mount. For inline, the container; for floating, ignored (pins to body). */
  target?: HTMLElement | string
  /** Override the "Powered by Lookalike" link with an HTTP(S) URL. Relative URLs resolve against the service origin. */
  brandHref?: string
}

// A `type` (not `interface`) so it carries an implicit index signature and
// satisfies the emitter's `Record<string, unknown[]>` constraint.
export type WidgetEventMap = {
  /** Iframe loaded and handshake complete. */
  ready: [{ version: string }]
  /** A chat session went live. */
  connect: [{ mode: ChatMode }]
  /** The session ended (any reason). */
  disconnect: []
  /** A complete message arrived (user or assistant). */
  message: [{ role: "user" | "assistant"; content: string }]
  /** A streaming transcription line (question = user speech, answer = avatar). */
  transcript: [{ role: "user" | "assistant"; content: string; messageId: string; timestamp: number }]
  /** The live mode changed (text/audio/video). */
  "mode-change": [ChatMode]
  /** The avatar started/stopped speaking. */
  "speaking-change": [boolean]
  /** Frame size class changed (collapsed pill ↔ expanded ↔ minimized). */
  resize: [{ collapsed: boolean; mode: ChatMode | null; minimized: boolean }]
  /** The avatar invoked a host-page client tool. */
  "tool-call": [{ id: string; name: string; args: unknown }]
  /** A transport or runtime error. */
  error: [Error]
}

export type WidgetEvent = keyof WidgetEventMap

export interface Widget {
  /** Subscribe to an event. Returns an unsubscribe fn. */
  on<K extends WidgetEvent>(type: K, cb: (...args: WidgetEventMap[K]) => void): () => void
  /** Unsubscribe a previously-registered listener. */
  off<K extends WidgetEvent>(type: K, cb: (...args: WidgetEventMap[K]) => void): void

  /** Expand the collapsed pill / restore a minimized session (starts a session if none). */
  start(mode?: ChatMode): void
  /** End the live session and collapse to the pill. */
  stop(): void
  /** Send a user message (a turn — the avatar responds). Starts a text session if none. */
  sendMessage(text: string): void
  /** Inject silent LLM context (no user turn, no response). */
  injectContext(text: string): void
  /** Make the avatar speak text verbatim (bypasses the LLM). */
  speak(text: string): void
  /** Switch the live mode (or open in it if not yet live). */
  setMode(mode: ChatMode): void
  /** Mute/unmute the visitor's mic. */
  setMuted(muted: boolean): void

  /** Expand the widget (open the pill). */
  expand(): void
  /** Shrink a live session to the corner pill (session keeps running). */
  minimize(): void
  /** Alias of expand(). */
  open(): void
  /** Alias of stop()/collapse. */
  close(): void

  /** Reply to a `tool-call` with a result (or error). */
  resolveTool(id: string, result: unknown, error?: string): void

  /** Update theme, overrides, teaser text, and merge clientTools. Pass clientTools: undefined to clear tools.
   * Structural options (token, origin, modes, position, anchor, target, drag) require a new widget. */
  update(partial: Partial<WidgetConfig>): void
  /** Tear down the widget, listeners, and DOM. */
  destroy(): void
}
