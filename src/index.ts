// `@lookalike/widget` — the vanilla entry point.
//
// Importing this registers the `<lookalike-widget>` custom element (SSR-safe,
// idempotent) and exposes the imperative `createWidget()` API + the wire
// protocol + the drag harness.

export * from "./protocol"
export { CLIENT_TOOLS, CLIENT_TOOL_NAMES, isClientToolName, defineTool, navigationTool } from "./tools"
export type { ClientToolName, ClientToolSpec, NavigationToolOptions } from "./tools"

export { attachDragHarness, PEEK_WIDTH } from "./drag"
export type { DragAnchor, DragHandle, AttachOptions } from "./drag"

export { createWidget } from "./core/createWidget"
export { resolveAndCreateWidget } from "./core/config"
export type { WidgetLoadOptions } from "./core/config"
export { scriptOrigin } from "./core/origin"
export { createTransport } from "./core/transport"
export type { Transport, TransportOptions, ResizeState, DragSignal } from "./core/transport"
export { Emitter } from "./core/emitter"
export type {
  Widget,
  WidgetConfig,
  WidgetEvent,
  WidgetEventMap,
  TeaserConfig,
  ClientTool,
  ClientToolDef,
  ClientTools,
} from "./core/types"

export { LookalikeWidgetElement, defineLookalikeWidget } from "./element"
export type { WidgetDOMEvent, WidgetDOMEventMap } from "./element"

// Side-effect: register <lookalike-widget>. `element` self-registers on import,
// this keeps the registration in the export graph for bundlers.
import "./element"
