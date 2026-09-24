import { createElement, useEffect, useRef } from "react"
import { WIDGET_DOM_EVENTS, type LookalikeWidgetElement, type WidgetDOMEvent } from "../element"
import type { WidgetConfig } from "../core/types"

export interface LookalikeWidgetProps extends Pick<WidgetConfig,
  "token" | "origin" | "modes" | "position" | "anchor" | "draggable" | "theme" | "clientTools"
> {
  teaserText?: string
  teaserDelay?: number
  className?: string
  style?: React.CSSProperties
  /** Native widget event; event.type narrows the type of event.detail. */
  onEvent?: (event: WidgetDOMEvent) => void
}

/** React 18+ adapter. The custom element owns loading and cleanup. */
export function LookalikeWidget(props: LookalikeWidgetProps) {
  const ref = useRef<LookalikeWidgetElement | null>(null)
  const latest = useRef(props)
  latest.current = props

  // React 18 cannot set rich custom-element properties through JSX.
  useEffect(() => {
    if (!ref.current) return
    ref.current.clientTools = props.clientTools
    ref.current.theme = props.theme
  }, [props.clientTools, props.theme])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const handleEvent = (event: WidgetDOMEvent) => latest.current.onEvent?.(event)
    WIDGET_DOM_EVENTS.forEach(type => el.addEventListener(type, handleEvent))
    return () => WIDGET_DOM_EVENTS.forEach(type => el.removeEventListener(type, handleEvent))
  }, [])

  return createElement("lookalike-widget", {
    ref,
    token: props.token,
    origin: props.origin,
    anchor: props.anchor,
    position: props.position,
    modes: props.modes?.join(","),
    draggable: props.draggable,
    "teaser-text": props.teaserText,
    "teaser-delay": props.teaserDelay != null ? String(props.teaserDelay) : undefined,
    class: props.className,
    style: props.style,
  })
}
