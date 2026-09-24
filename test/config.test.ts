import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveAndCreateWidget } from "../src/core/config"
import { installDOM } from "./dom"

test("cancelling a pending mount never creates a late widget or fetches config", async () => {
  const dom = installDOM()
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected config fetch") }
  try {
    const controller = new AbortController()
    const pending = resolveAndCreateWidget({ token: "test" }, { signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, { name: "AbortError" })
    assert.equal(dom.document.querySelector("[data-lookalike-host]"), null)
    await assert.rejects(resolveAndCreateWidget({ token: "test" }, { signal: controller.signal }), { name: "AbortError" })
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = originalFetch
    dom.restore()
  }
})

test("widgets mount directly with the supplied appearance and modes, without fetching config", async () => {
  const dom = installDOM()
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected config fetch") }
  try {
    const target = dom.document.createElement("main")
    dom.document.body.append(target)
    const widget = await resolveAndCreateWidget({ token: "public/token", modes: ["text"], position: "inline", target })
    assert.equal(requests, 0)
    const frame = target.querySelector("[data-lookalike-host]")?.shadowRoot?.querySelector("iframe")
    assert.ok(frame)
    assert.equal(new URL(frame.src).searchParams.get("modes"), "text")
    assert.equal(new URL(frame.src).origin, "https://lookalike.com")
    widget.destroy()
    assert.equal(target.children.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    dom.restore()
  }
})

test("token-only mounting uses SDK appearance defaults and lets the iframe resolve modes", async () => {
  const dom = installDOM()
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ position: "inline", modes: ["text"], draggable: true })) }
  try {
    const widget = await resolveAndCreateWidget({ token: "test" })
    const host = dom.document.querySelector<HTMLElement>("[data-lookalike-host]")
    assert.ok(host)
    assert.equal(host.style.position, "fixed")
    assert.equal(host.style.right, "16px")
    assert.equal(host.style.touchAction, "none", "floating widgets enable dragging by default")
    assert.equal(requests, 0, "saved preferences must not be requested")
    const frame = host.shadowRoot?.querySelector("iframe")
    assert.ok(frame)
    assert.equal(new URL(frame.src).searchParams.get("modes"), null)
    widget.destroy()
  } finally {
    globalThis.fetch = originalFetch
    dom.restore()
  }
})


test("explicit false and inline placement disable dragging", async () => {
  const dom = installDOM()
  try {
    for (const config of [{ draggable: false }, { position: "inline" as const, draggable: true }]) {
      const widget = await resolveAndCreateWidget({ token: "test", ...config })
      const host = dom.document.querySelector<HTMLElement>("[data-lookalike-host]")
      assert.ok(host)
      assert.notEqual(host.style.touchAction, "none")
      widget.destroy()
    }
  } finally {
    dom.restore()
  }
})
