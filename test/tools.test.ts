import assert from "node:assert/strict"
import { test } from "node:test"
import { createTransport } from "../src/core/transport"
import type { ClientTools } from "../src/core/types"
import { HOST_COMMAND, PROTO_VERSION, TOOL_CALL, WIDGET_READY } from "../src/protocol"
import { defineTool, isClientToolName, navigationTool } from "../src/tools"
import { installDOM } from "./dom"

function toolHarness(getTools: () => ClientTools) {
  const dom = installDOM()
  const originalChannel = Object.getOwnPropertyDescriptor(globalThis, "MessageChannel")
  class Port {
    messages: unknown[] = []
    onmessage: ((event: { data: unknown }) => void) | null = null
    postMessage(message: unknown) { this.messages.push(message) }
    close() { this.onmessage = null }
  }
  const ports: Port[] = []
  Object.defineProperty(globalThis, "MessageChannel", {
    configurable: true,
    value: class {
      port1 = new Port()
      port2 = new Port()
      constructor() { ports.push(this.port1) }
    },
  })
  const frame = dom.document.createElement("iframe")
  frame.src = "https://lookalike.com/embed/test"
  dom.document.body.append(frame)
  assert.ok(frame.contentWindow)
  Object.defineProperty(frame.contentWindow, "postMessage", { value() {} })
  const transport = createTransport({ getFrame: () => frame, clientTools: getTools })
  const errors: Error[] = []
  const unhandled: unknown[] = []
  transport.emitter.on("error", error => errors.push(error))
  transport.emitter.on("tool-call", call => unhandled.push(call))
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    source: frame.contentWindow,
    origin: "https://lookalike.com",
    data: { type: WIDGET_READY, version: PROTO_VERSION, instanceId: "tools-test" },
  }))
  const port = ports[0]
  assert.ok(port)
  return {
    async call(name: string, args: unknown, id = "call-1") {
      port.messages.length = 0
      errors.length = 0
      unhandled.length = 0
      port.onmessage?.({ data: { type: TOOL_CALL, id, name, args } })
      await new Promise(resolve => setImmediate(resolve))
      return { messages: [...port.messages], errors: [...errors], unhandled: [...unhandled] }
    },
    sync: () => transport.syncClientTools(),
    restore() {
      transport.destroy()
      if (originalChannel) Object.defineProperty(globalThis, "MessageChannel", originalChannel)
      else Reflect.deleteProperty(globalThis, "MessageChannel")
      dom.restore()
    },
  }
}

function assertToolError(result: Awaited<ReturnType<ReturnType<typeof toolHarness>["call"]>>, id: string) {
  assert.equal(result.errors.length, 1)
  assert.ok(result.errors[0].message.length > 0)
  assert.deepEqual(result.messages, [{
    type: HOST_COMMAND, action: "tool-result", payload: { id, error: result.errors[0].message },
  }])
  assert.deepEqual(result.unhandled, [], "invalid declared arguments must not reach a fallback handler")
}

test("defineTool validates required, nested, enum and closed-object arguments before its handler", async () => {
  let calls = 0
  const tool = defineTool({
    description: "Save a profile",
    parameters: {
      type: "object",
      properties: {
        profile: {
          type: "object",
          properties: { name: { type: "string", minLength: 1 }, level: { enum: ["basic", "pro"] } },
          required: ["name", "level"],
          additionalProperties: false,
        },
      },
      required: ["profile"],
      additionalProperties: false,
    },
    handler({ profile }) { calls++; return profile.name },
  })
  const invalid = [
    null, [], "profile", {}, { profile: null }, { profile: { name: "Ada" } },
    { profile: { name: 42, level: "basic" } }, { profile: { name: "", level: "basic" } },
    { profile: { name: "Ada", level: "admin" } },
    { profile: { name: "Ada", level: "basic", surprise: true } },
    { profile: { name: "Ada", level: "basic" }, surprise: true },
  ]
  for (const args of invalid) await assert.rejects(async () => tool.handler(args), /Invalid tool arguments/)
  assert.equal(calls, 0)
  assert.equal(await tool.handler({ profile: { name: "Ada", level: "basic" } }), "Ada")
  assert.equal(calls, 1)
})

test("defineTool leaves defaults and the supplied schema unchanged", async () => {
  const schema = {
    type: "object",
    properties: { label: { type: "string", default: "Suggested" } },
    additionalProperties: false,
  } as const
  const before = JSON.stringify(schema)
  const tool = defineTool({ description: "Read optional label", parameters: schema, handler: args => args })
  const args = Object.freeze({})
  assert.equal(await tool.handler(args), args)
  assert.deepEqual(args, {})
  assert.equal(JSON.stringify(schema), before)
})

test("defineTool resolves local definitions and validates referenced arguments", async () => {
  let calls = 0
  const tool = defineTool({
    description: "Save a referenced quantity",
    parameters: {
      type: "object",
      definitions: { quantity: { type: "integer", minimum: 1 } },
      properties: { quantity: { $ref: "#/definitions/quantity" } },
      required: ["quantity"],
      additionalProperties: false,
    },
    handler({ quantity }) { calls++; return quantity },
  })
  for (const args of [{}, { quantity: "2" }, { quantity: 0 }, { quantity: 1.5 }]) {
    await assert.rejects(async () => tool.handler(args), /Invalid tool arguments/)
  }
  assert.equal(calls, 0)
  assert.equal(await tool.handler({ quantity: 2 }), 2)
  assert.equal(calls, 1)
})

test("unresolved local and external references never invoke handlers or fetch schemas", async t => {
  let calls = 0
  let fetches = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { fetches++; throw new Error("No schema fetching is permitted") }
  t.after(() => { globalThis.fetch = originalFetch })
  for (const reference of ["#/definitions/missing", "https://schemas.example/quantity.json"]) {
    const tool = defineTool({
      description: "Invalid reference",
      parameters: { type: "object", properties: { quantity: { $ref: reference } }, required: ["quantity"] },
      handler() { calls++; return "must not run" },
    })
    await assert.rejects(async () => tool.handler({ quantity: 2 }))
  }
  assert.equal(calls, 0)
  assert.equal(fetches, 0)
})

test("transport rejects malformed raw tool and bare preset arguments with matching result errors", async t => {
  let rawCalls = 0
  let presetCalls = 0
  const harness = toolHarness(() => ({
    save: {
      description: "Save a quantity",
      parameters: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false },
      handler: () => { rawCalls++; return "saved" },
    },
    navigateTo: async () => { presetCalls++; return "navigated" },
  }))
  t.after(harness.restore)
  for (const [index, args] of [null, [], {}, { count: "2" }, { count: 0 }, { count: 1.5 }, { count: 2, extra: true }].entries()) {
    const id = `raw-${index}`
    assertToolError(await harness.call("save", args, id), id)
  }
  for (const [index, args] of [undefined, {}, { url: 123 }, { url: null }].entries()) {
    const id = `preset-${index}`
    assertToolError(await harness.call("navigateTo", args, id), id)
  }
  assert.equal(rawCalls, 0)
  assert.equal(presetCalls, 0)
  assert.deepEqual((await harness.call("save", { count: 2 })).messages, [{ type: HOST_COMMAND, action: "tool-result", payload: { id: "call-1", result: "saved" } }])
  assert.deepEqual((await harness.call("navigateTo", { url: "/pricing" })).messages, [{ type: HOST_COMMAND, action: "tool-result", payload: { id: "call-1", result: "navigated" } }])
  assert.equal(rawCalls, 1)
  assert.equal(presetCalls, 1)
})

test("transport validates a replacement schema rather than reusing the previous tool's validator", async t => {
  let calls = 0
  let tools: ClientTools = {
    save: { description: "Save text", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, handler: () => { calls++; return "saved" } },
  }
  const harness = toolHarness(() => tools)
  t.after(harness.restore)
  assert.equal((await harness.call("save", { value: "first" })).errors.length, 0)
  tools = {
    save: { description: "Save number", parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] }, handler: () => { calls++; return "saved" } },
  }
  harness.sync()
  assertToolError(await harness.call("save", { value: "old-schema" }, "replacement"), "replacement")
  assert.equal((await harness.call("save", { value: 2 })).errors.length, 0)
  assert.equal(calls, 2)
})

test("transport follows edits to a schema object already used by the validator", async t => {
  let calls = 0
  const parameters = { type: "object", properties: { value: { type: "string", minLength: 1 } }, required: ["value"] } as const
  const harness = toolHarness(() => ({ save: { description: "Save", parameters, handler: () => { calls++; return "saved" } } }))
  t.after(harness.restore)
  assert.equal((await harness.call("save", { value: "a" })).errors.length, 0)
  Object.assign(parameters.properties.value, { minLength: 3 })
  harness.sync()
  assertToolError(await harness.call("save", { value: "a" }, "changed"), "changed")
  assert.equal((await harness.call("save", { value: "abc" })).errors.length, 0)
  assert.equal(calls, 2)
})

test("inherited tool names are neither presets nor executable registered handlers", async t => {
  let calls = 0
  const tools: ClientTools = {}
  Object.setPrototypeOf(tools, { inheritedAction: () => { calls++; return "must not run" } })
  const harness = toolHarness(() => tools)
  t.after(harness.restore)
  for (const name of ["constructor", "toString", "__proto__", "inheritedAction"]) {
    assert.equal(isClientToolName(name), false)
    const result = await harness.call(name, {}, name)
    assert.deepEqual(result.messages, [])
    assert.deepEqual(result.unhandled, [{ id: name, name, args: {} }])
  }
  assert.equal(calls, 0)
})

test("navigationTool enforces HTTP(S), credentials and exact-origin policy before the router", async t => {
  const dom = installDOM()
  t.after(dom.restore)
  const navigated: string[] = []
  const tool = navigationTool({ navigate: url => navigated.push(url) })
  for (const url of [
    "javascript:alert(1)", "data:text/html,hello", "file:///tmp/test", "//evil.example/path",
    "https://customer.example.evil/path", "https://customer.example@evil.example/path",
    "http://customer.example/path", "https://customer.example:8443/path",
    "https://user:password@customer.example/path", "https://[invalid",
  ]) await assert.rejects(async () => tool.handler({ url }))
  assert.deepEqual(navigated, [])
  await tool.handler({ url: "/docs/../pricing?plan=pro#compare" })
  await tool.handler({ url: "https://customer.example/help" })
  assert.deepEqual(navigated, ["/pricing?plan=pro#compare", "/help"])
  await tool.handler({ url: "https://customer.example//evil.example/path" })
  assert.equal(navigated.at(-1), "https://customer.example//evil.example/path")
  assert.equal(new URL(navigated.at(-1) ?? "", dom.window.location.href).origin, dom.window.location.origin)

  const external = navigationTool({ allowedOrigins: ["https://partner.example"], navigate: url => navigated.push(url) })
  await external.handler({ url: "https://partner.example/docs?q=1#intro" })
  await assert.rejects(async () => external.handler({ url: "https://partner.example.evil/docs" }))
  await assert.rejects(async () => external.handler({ url: "https://partner.example:8443/docs" }))
  assert.equal(navigated.at(-1), "https://partner.example/docs?q=1#intro")
})

test("navigationTool uses browser navigation when no router callback is supplied", async t => {
  const dom = installDOM()
  t.after(dom.restore)
  const navigated: string[] = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: dom.window.location.href, origin: dom.window.location.origin, assign: (url: string) => navigated.push(url) } },
  })
  await navigationTool().handler({ url: "/pricing" })
  await navigationTool().handler({ url: "https://customer.example//evil.example/path" })
  assert.deepEqual(navigated, ["https://customer.example/pricing", "https://customer.example//evil.example/path"])
})

test("navigation callback failures become tool-result errors rather than successful navigation", async t => {
  let calls = 0
  const harness = toolHarness(() => ({
    navigateTo: navigationTool({ navigate: async () => { calls++; throw new Error("Router unavailable") } }),
  }))
  t.after(harness.restore)
  const result = await harness.call("navigateTo", { url: "/pricing" }, "router-failure")
  assertToolError(result, "router-failure")
  assert.equal(result.errors[0].message, "Router unavailable")
  assert.equal(calls, 1)
})
