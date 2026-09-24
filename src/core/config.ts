import { createWidget } from "./createWidget"
import type { Widget, WidgetConfig } from "./types"

export interface WidgetLoadOptions {
  /** Cancel a pending mount, for example when the host component unmounts. */
  signal?: AbortSignal
}

/**
 * Mount on the next microtask so queued shutdowns can cancel initialization.
 * No configuration request: the iframe resolves its policy during loading.
 */
export async function resolveAndCreateWidget(config: WidgetConfig, options: WidgetLoadOptions = {}): Promise<Widget> {
  options.signal?.throwIfAborted()
  await Promise.resolve()
  options.signal?.throwIfAborted()
  return createWidget(config)
}
