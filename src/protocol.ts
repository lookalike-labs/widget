// The wire contract between a host page and the `/embed/<token>` iframe.
//
// Shared message names and payloads for the host and embedded conversation.
// The host transfers a MessageChannel port after the iframe announces readiness.

export const PROTO_VERSION = "2.0.0"

export type ChatMode = "text" | "audio" | "video"
export type EmbedAnchor = "bottom-right" | "bottom-left" | "top-right" | "top-left"
export type EmbedPosition = "floating" | "inline"

// ── Host → widget ────────────────────────────────────────────────────────────
// Most host→widget traffic is a single envelope carrying an `action`. A few
// transport/layout signals are their own message types (they predate the
// envelope and the snippet/host send them before the port exists).

export const HOST_COMMAND = "lookalike-command" as const
export const HOST_INIT_CHANNEL = "lookalike-init-channel" as const
export const HOST_READY = "lookalike-host-ready" as const
export const HOST_FULLSCREEN = "lookalike-host-fullscreen" as const

export type CommandAction =
  | "expand"
  | "minimize"
  | "start-session"
  | "set-mode"
  | "send-text"
  | "keepalive"
  | "end-session"
  | "inject-context" // silent LLM context, no user turn
  | "speak" // verbatim TTS, bypasses the LLM
  | "set-muted" // mute/unmute the visitor mic
  | "set-overrides" // per-session overrides applied when the next session starts
  | "set-client-tools" // host-declared tool specs, sent to the agent at session start
  | "set-theme" // push theme tokens into the iframe UI
  | "tool-result" // result of a host-run client tool, replying to a `tool-call` event

// Per-action payloads. All optional fields — handlers validate defensively.
export interface CommandPayloads {
  "expand": void
  "minimize": void
  "start-session": { mode?: ChatMode; muteDialTone?: boolean; overrides?: SessionOverrides }
  "set-mode": { mode: ChatMode }
  "send-text": { text: string; muteTextNotification?: boolean }
  "keepalive": { seconds?: number }
  "end-session": void
  "inject-context": { text: string }
  "speak": { text: string }
  "set-muted": { muted: boolean }
  "set-overrides": { overrides: SessionOverrides }
  "set-client-tools": { tools: Record<string, ClientToolWireSpec> }
  "set-theme": { tokens: ThemeTokens }
  "tool-result": { id: string; result?: unknown; error?: string }
}

// Per-session overrides carried on `start-session` (and persisted to chat
// metadata server-side). All optional.
export interface SessionOverrides {
  firstMessage?: string
  dynamicVariables?: Record<string, string>
  systemPromptAddition?: string
}

// A host-declared client tool's LLM-facing spec (no handler — that stays in
// the host page). Forwarded to the server at session start.
export interface ClientToolWireSpec {
  description: string
  parameters: {
    type: "object"
    properties?: Record<string, unknown>
    required?: readonly string[]
    [keyword: string]: unknown
  }
}

export interface ThemeTokens {
  /** Send-button background, as a CSS color. */
  accent?: string
  /** Send-button icon, as a CSS color. */
  "accent-foreground"?: string
}

export interface CommandMessage<A extends CommandAction = CommandAction> {
  type: typeof HOST_COMMAND
  action: A
  payload?: CommandPayloads[A]
}

export interface InitChannelMessage {
  type: typeof HOST_INIT_CHANNEL
}
export interface HostReadyMessage {
  type: typeof HOST_READY
}
export interface HostFullscreenMessage {
  type: typeof HOST_FULLSCREEN
  fullscreen: boolean
}

export type HostToWidgetMessage =
  | CommandMessage
  | InitChannelMessage
  | HostReadyMessage
  | HostFullscreenMessage

// ── Widget → host ────────────────────────────────────────────────────────────
// Each widget→host message is its own discriminated `type`.

export const WIDGET_READY = "lookalike-widget-ready" as const
export const WIDGET_RESIZE = "lookalike-widget-resize" as const
export const WIDGET_GREETING = "lookalike-widget-greeting" as const
export const WIDGET_PAINTED = "lookalike-widget-painted" as const
export const SESSION_START = "lookalike-session-start" as const
export const SESSION_END = "lookalike-session-end" as const
export const MESSAGE = "lookalike-message" as const
export const QUESTION_TRANSCRIPTION = "lookalike-question-transcription" as const
export const ANSWER_TRANSCRIPTION = "lookalike-answer-transcription" as const
export const RESPONSE_START = "lookalike-response-start" as const
export const RESPONSE_END = "lookalike-response-end" as const
export const DRAG_START = "lookalike-drag-start" as const
export const DRAG_UPDATE = "lookalike-drag-update" as const
export const DRAG_END = "lookalike-drag-end" as const
export const TOOL_CALL = "lookalike-tool-call" as const

export interface WidgetReadyMessage {
  type: typeof WIDGET_READY
  version: string
  // Unique per iframe document load — lets the host tell a genuine reload (new
  // id → rebuild the channel) from a duplicate ready announce (same id → ignore).
  instanceId: string
}
export interface WidgetResizeMessage {
  type: typeof WIDGET_RESIZE
  collapsed: boolean
  mode: ChatMode | null
  minimized: boolean
  // Whether the host should show the "Powered by Lookalike" caption (server
  // resolved; rides on resize so there's no separate message).
  brand: boolean
}
export interface WidgetGreetingMessage {
  type: typeof WIDGET_GREETING
  text: string
}
export interface WidgetPaintedMessage {
  type: typeof WIDGET_PAINTED
}
export interface SessionStartMessage {
  type: typeof SESSION_START
  mode: ChatMode
}
export interface SessionEndMessage {
  type: typeof SESSION_END
}
export interface MessageEventMessage {
  type: typeof MESSAGE
  role: "user" | "assistant"
  content: string
}
export interface TranscriptionMessage {
  type: typeof QUESTION_TRANSCRIPTION | typeof ANSWER_TRANSCRIPTION
  role: "user" | "assistant"
  content: string
  timestamp: number
  messageId: string
}
export interface ResponseStartMessage {
  type: typeof RESPONSE_START
  mode: ChatMode
  state: string
}
export interface ResponseEndMessage {
  type: typeof RESPONSE_END
  mode: ChatMode
  state: string
  complete: boolean
}
export interface DragMessage {
  type: typeof DRAG_START | typeof DRAG_UPDATE | typeof DRAG_END
  screenX?: number
  screenY?: number
  t?: number
}
export interface ToolCallMessage {
  type: typeof TOOL_CALL
  id: string
  name: string
  args?: unknown
}

export type WidgetToHostMessage =
  | WidgetReadyMessage
  | WidgetResizeMessage
  | WidgetGreetingMessage
  | WidgetPaintedMessage
  | SessionStartMessage
  | SessionEndMessage
  | MessageEventMessage
  | TranscriptionMessage
  | ResponseStartMessage
  | ResponseEndMessage
  | DragMessage
  | ToolCallMessage

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the `/embed/<token>` iframe URL. The iframe only needs the allowed
 * modes (everything else is resolved server-side by token); omit the `modes`
 * query when all three are allowed so the URL stays clean.
 */
export function embedUrlFor(token: string, origin: string, modes: ChatMode[]): string {
  const query = modes.length > 0 && modes.length < 3 ? `?modes=${modes.join(",")}` : ""
  return `${origin}/embed/${encodeURIComponent(token)}${query}`
}

/** Build a typed host→widget command envelope. */
export function command<A extends CommandAction>(
  action: A,
  payload?: CommandPayloads[A],
): CommandMessage<A> {
  return payload === undefined
    ? { type: HOST_COMMAND, action }
    : { type: HOST_COMMAND, action, payload }
}

/** Narrow an unknown message to a widget→host message of a given type. */
export function isWidgetMessage<T extends WidgetToHostMessage["type"]>(
  data: unknown,
  type: T,
): data is Extract<WidgetToHostMessage, { type: T }> {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === type
}
