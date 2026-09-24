import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createWidget } from "../src/core/createWidget"
import { LookalikeWidget } from "../src/react/LookalikeWidget"
import { installDOM } from "./dom"

test("the React component renders its custom element without a browser", () => {
  const markup = renderToStaticMarkup(createElement(LookalikeWidget, {
    token: "public-token",
    modes: ["text"],
    position: "inline",
  }))
  assert.match(markup, /<lookalike-widget[^>]*token="public-token"/)
  assert.match(markup, /position="inline"/)
  assert.match(markup, /modes="text"/)
})

test("widget creates accessible, injection-safe branding and removes its DOM on destroy", () => {
  const dom = installDOM()
  try {
    const widget = createWidget({
      token: "public-token",
      modes: ["text"],
      brandHref: 'https://example.com/" onclick="alert(1)',
    })
    const host = dom.document.querySelector("[data-lookalike-host]")
    assert.ok(host?.shadowRoot)
    const frame = host.shadowRoot.querySelector("iframe")
    const link = host.shadowRoot.querySelector("a")
    assert.ok(frame?.title.trim(), "iframe must have an accessible title")
    assert.ok(link)
    assert.equal(link.hasAttribute("onclick"), false, "configuration must not become HTML attributes")
    assert.equal(host.shadowRoot.querySelectorAll("a").length, 1)
    assert.equal(link.textContent, "Lookalike")
    assert.match(link.rel, /noopener/)
    assert.equal(frame.hasAttribute("allow"), false, "text-only embeds do not request microphone access")
    widget.destroy()
    widget.destroy()
    assert.equal(dom.document.querySelector("[data-lookalike-host]"), null)
  } finally {
    dom.restore()
  }
})

test("branding rejects executable URLs", () => {
  const dom = installDOM()
  try {
    assert.throws(() => createWidget({ token: "public-token", brandHref: "javascript:alert(1)" }), /HTTP\(S\)/)
    assert.equal(dom.document.querySelector("[data-lookalike-host]"), null)
  } finally {
    dom.restore()
  }
})
