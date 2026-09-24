import assert from "node:assert/strict"
import { test } from "node:test"
import { createTransport } from "../src/core/transport"
import { HOST_INIT_CHANNEL, HOST_COMMAND, MESSAGE, PROTO_VERSION, WIDGET_READY } from "../src/protocol"
import { installDOM } from "./dom"

test("handshake flushes tools before queued commands once and cleanup stops delivery", () => {
  const dom = installDOM()
  const originalChannel = Object.getOwnPropertyDescriptor(globalThis, "MessageChannel")
  class Port {
    messages: unknown[] = []
    closed = false
    onmessage: ((event: { data: unknown }) => void) | null = null
    postMessage(message: unknown) { this.messages.push(message) }
    close() { this.closed = true; this.onmessage = null }
  }
  const channels: Array<{ port1: Port; port2: Port }> = []
  Object.defineProperty(globalThis, "MessageChannel", {
    configurable: true,
    value: class {
      port1 = new Port()
      port2 = new Port()
      constructor() { channels.push(this) }
    },
  })
  try {
    const frame = dom.document.createElement("iframe")
    frame.src = "https://lookalike.com/embed/test"
    dom.document.body.append(frame)
    assert.ok(frame.contentWindow)
    const posted: Array<{ message: unknown; origin: unknown }> = []
    Object.defineProperty(frame.contentWindow, "postMessage", {
      value: (message: unknown, origin: unknown) => posted.push({ message, origin }),
    })
    const transport = createTransport({
      getFrame: () => frame,
      onReady: () => transport.send("set-overrides", { overrides: { firstMessage: "Welcome" } }),
      clientTools: () => ({
        echo: { description: "Echo input", parameters: { type: "object", properties: {} }, handler: () => "echo" },
      }),
    })
    const messages: string[] = []
    transport.emitter.on("message", message => messages.push(message.content))
    transport.send("start-session", { mode: "text" })
    transport.send("send-text", { text: "hello" })
    assert.equal(channels.length, 0)
    const announce = (source: Window | null, instanceId = "first") => dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
      source,
      origin: "https://lookalike.com",
      data: { type: WIDGET_READY, version: PROTO_VERSION, instanceId },
    }))
    announce(null)
    assert.equal(channels.length, 0, "unrelated frames must not complete the handshake")
    announce(frame.contentWindow)
    assert.equal(channels.length, 1)
    assert.deepEqual(posted.at(-1), { message: { type: HOST_INIT_CHANNEL }, origin: "https://lookalike.com" })
    assert.deepEqual(channels[0].port1.messages, [
      { type: HOST_COMMAND, action: "set-client-tools", payload: { tools: { echo: { description: "Echo input", parameters: { type: "object", properties: {} } } } } },
      { type: HOST_COMMAND, action: "set-overrides", payload: { overrides: { firstMessage: "Welcome" } } },
      { type: HOST_COMMAND, action: "start-session", payload: { mode: "text" } },
      { type: HOST_COMMAND, action: "send-text", payload: { text: "hello" } },
    ])
    announce(frame.contentWindow)
    assert.equal(channels.length, 1, "duplicate ready must not replay queued user turns")
    channels[0].port1.onmessage?.({ data: { type: MESSAGE, role: "assistant", content: "Hello" } })
    assert.deepEqual(messages, ["Hello"])
    announce(frame.contentWindow, "reload")
    assert.equal(channels.length, 2)
    assert.equal(channels[0].port1.closed, true)
    assert.equal(channels[1].port1.messages.length, 2, "reload resends tools and overrides, not old user turns")
    transport.destroy()
    transport.destroy()
    assert.equal(channels[1].port1.closed, true)
    announce(frame.contentWindow, "after-destroy")
    assert.equal(channels.length, 2)
    assert.deepEqual(messages, ["Hello"])
  } finally {
    if (originalChannel) Object.defineProperty(globalThis, "MessageChannel", originalChannel)
    else Reflect.deleteProperty(globalThis, "MessageChannel")
    dom.restore()
  }
})
