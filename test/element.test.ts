import assert from "node:assert/strict"
import { test } from "node:test"
import { installDOM } from "./dom"
import type { WidgetConfig } from "../src/core/types"
import { WIDGET_READY, PROTO_VERSION, TOOL_CALL } from "../src/protocol"

test("custom element aborts a pending mount when removed, then mounts and cleans up on reconnect", async () => {
  const dom = installDOM()
  const originalFetch = globalThis.fetch
  try {
    let requests = 0
    globalThis.fetch = async () => { requests++; throw new Error("Unexpected config fetch") }
    // Load the element only after the browser realm exists: its HTMLElement
    // base intentionally uses an SSR-safe stub when imported without a DOM.
    const { defineLookalikeWidget } = await import("../src/element")
    defineLookalikeWidget()
    const element = dom.document.createElement("lookalike-widget")
    element.setAttribute("token", "test")
    dom.document.body.append(element)
    element.remove()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(dom.document.querySelector("[data-lookalike-host]"), null)

    let config: WidgetConfig | undefined
    element.addEventListener("lookalike:call", event => { config = event.detail.config })
    element.setAttribute("modes", "text")
    element.setAttribute("position", "inline")
    element.setAttribute("draggable", "false")
    dom.document.body.append(element)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(element.querySelectorAll("[data-lookalike-host]").length, 1)
    assert.equal(requests, 0, "custom-element mounting must not fetch configuration")
    assert.equal(config?.draggable, false, "the HTML false value must remain false")
    const frame = element.querySelector("[data-lookalike-host]")?.shadowRoot?.querySelector("iframe")
    assert.ok(frame)
    // Connect the widget to a real MessageChannel without loading a service.
    Object.defineProperty(frame, "contentWindow", { value: dom.window })
    let peer: MessagePort | undefined
    let resolveResult: (() => void) | undefined
    const result = new Promise<void>(resolve => { resolveResult = resolve })
    const messages: Array<{ action: string; payload?: { tokens?: unknown; id?: string } }> = []
    Object.defineProperty(dom.window, "postMessage", { value: (_message: unknown, _origin: string, ports: MessagePort[]) => {
      peer = ports[0]
      peer.onmessage = event => {
        messages.push(event.data)
        if (event.data.payload?.id === "next") resolveResult?.()
      }
    } })
    let oldCalls = 0
    let nextCalls = 0
    element.clientTools = { oldTool: { description: "Old", parameters: { type: "object" }, handler: () => { oldCalls++; return "old" } } }
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
      source: dom.window, origin: "https://lookalike.com",
      data: { type: WIDGET_READY, version: PROTO_VERSION, instanceId: "test" },
    }))
    assert.ok(peer)
    element.clientTools = { nextTool: { description: "Next", parameters: { type: "object" }, handler: () => { nextCalls++; return "next" } } }
    element.theme = { accent: "red" }
    element.theme = undefined
    peer.postMessage({ type: TOOL_CALL, id: "old", name: "oldTool", args: {} })
    peer.postMessage({ type: TOOL_CALL, id: "next", name: "nextTool", args: {} })
    await result
    assert.equal(oldCalls, 0, "property replacement must revoke removed handlers")
    assert.equal(nextCalls, 1, "the replacement handler must still execute")
    assert.deepEqual(messages.filter(message => message.action === "set-theme").at(-1)?.payload, { tokens: {} }, "removing theme must reset the iframe")
    peer.close()
    element.setAttribute("origin", "https://alternate.example")
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(element.querySelectorAll("[data-lookalike-host]").length, 1)
    assert.match(element.querySelector("[data-lookalike-host]")?.shadowRoot?.querySelector("iframe")?.src ?? "", /^https:\/\/alternate\.example\/embed\/test/)
    element.remove()
    assert.equal(element.querySelector("[data-lookalike-host]"), null)
    assert.equal(dom.document.querySelector("[data-lookalike-host]"), null)
  } finally {
    globalThis.fetch = originalFetch
    dom.restore()
  }
})
