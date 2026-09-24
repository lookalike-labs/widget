# @lookalike/widget

Add text, voice, and video conversations with a [Lookalike](https://lookalike.com) to your website. Use the React component or the Web Component in Svelte, Vue, and plain HTML.

<a href="https://lookalike.com/sophie"><img src="https://raw.githubusercontent.com/lookalike-labs/widget/main/assets/widget-demo.avif" alt="Video conversation with Sophie in the Lookalike widget" width="320"></a>

Create an embed in **Share** in your Lookalike dashboard to get your public embed token.

## Install

```sh
npm install @lookalike/widget
```

For plain HTML or a site builder, use the [script tag](#script-tag).

### React / Next.js

```tsx
"use client"

import { LookalikeWidget } from "@lookalike/widget/react"

export default function Chat() {
  return <LookalikeWidget token="YOUR_TOKEN" />
}
```

Requires React 18 or newer. `className` and `style` apply to the container.

### Svelte / SvelteKit

```svelte
<script>
  import "@lookalike/widget/element"
</script>

<lookalike-widget token="YOUR_TOKEN"></lookalike-widget>
```

### Vue

```vue
<script setup>
import "@lookalike/widget/element"
</script>

<template>
  <lookalike-widget token="YOUR_TOKEN" />
</template>
```

Tell Vue to [treat `lookalike-widget` as a custom element](https://vuejs.org/guide/extras/web-components.html#skipping-component-resolution).

<details>
<summary>Vite configuration for Vue</summary>

```js
// vite.config.js
import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"

export default defineConfig({
  plugins: [vue({
    template: {
      compilerOptions: {
        isCustomElement: (tag) => tag === "lookalike-widget",
      },
    },
  })],
})
```

</details>

### Other frameworks / JavaScript

Import the element once in your app entry point:

```js
import "@lookalike/widget/element"
```

Then use `<lookalike-widget token="YOUR_TOKEN"></lookalike-widget>` in your page. No framework adapter is needed.

### Script tag

```html
<script src="https://unpkg.com/@lookalike/widget@3/dist/loader.global.js" defer></script>
<lookalike-widget token="YOUR_TOKEN"></lookalike-widget>
```

## Configuration

These options work across integrations. The default is a floating widget in the bottom-right corner. Use `position="inline"` to place it in your layout; it fills its container up to 360 px wide.

| Option | Values and behavior |
| --- | --- |
| `position` | `floating` or `inline` |
| `anchor` | `bottom-right`, `bottom-left`, `top-right`, `top-left`. Floating only |
| `draggable` | On by default. HTML: `draggable="false"`; React: `draggable={false}`. Floating only |
| `modes` | Offer a subset of the embed's allowed modes. HTML: `modes="text,video"`; React: `modes={["text", "video"]}`. Omit to offer all permitted modes |
| Teaser text | HTML: `teaser-text`; React: `teaserText`. Defaults to the avatar's greeting |
| Teaser delay | HTML: `teaser-delay="5"`; React: `teaserDelay={5}`. Seconds before showing the teaser; omitted means no automatic teaser |
| `theme` | Send-button colors: `{ accent: "#2563eb", "accent-foreground": "#ffffff" }`. Pass an object property or React prop; `{}` restores defaults |

Appearance comes from your code. Dashboard appearance changes update the recommended code; copy it again to change an installed widget. Allowed modes, domains, and session permissions are enforced by the service.

Removing the element or component ends the conversation and cleans up its resources. Changing `token`, `origin`, `modes`, `position`, `anchor`, or `draggable` recreates the widget and ends any active session.

## Events

Events are shared across every integration. Web Components dispatch `lookalike:*` DOM events with the payload in `event.detail`. React forwards them through `onEvent`.

| Event | Payload / when it fires |
| --- | --- |
| `lookalike:ready` | `{ version }`. The widget can accept commands |
| `lookalike:connect` | `{ mode }`. A conversation is live |
| `lookalike:disconnect` | The conversation ended |
| `lookalike:message` | `{ role, content }`. A complete user or assistant message |
| `lookalike:transcript` | `{ role, content, messageId, timestamp }`. Streaming text updates |
| `lookalike:mode-change` | `"text"`, `"audio"`, or `"video"` |
| `lookalike:speaking-change` | `true` when the avatar starts speaking, `false` when it stops |
| `lookalike:resize` | `{ collapsed, mode, minimized }` |
| `lookalike:tool-call` | `{ id, name, args }` |
| `lookalike:error` | An `Error` from the SDK or a client-tool handler |

**React:**

```tsx
<LookalikeWidget
  token="YOUR_TOKEN"
  onEvent={(event) => {
    if (event.type === "lookalike:message") {
      console.log(event.detail.role, event.detail.content)
    }
  }}
/>
```

**Svelte:**

```svelte
<script>
  import { on } from "svelte/events"
</script>

<lookalike-widget
  token="YOUR_TOKEN"
  {@attach (node) => on(node, "lookalike:message", onMessage)}
></lookalike-widget>
```

**Vue:**

```vue
<lookalike-widget token="YOUR_TOKEN" @lookalike:message="onMessage" />
```

In Svelte and Vue, `onMessage` receives the native event. Plain JavaScript uses the same event:

```js
const widget = document.querySelector("lookalike-widget")
widget.addEventListener("lookalike:message", (event) => {
  console.log(event.detail.role, event.detail.content)
})
```

Service availability errors appear inside the widget. Loader initialization failures before an instance exists emit `lookalike:error` on `window`.

## Client tools

Let the avatar navigate your site, add items to a cart, or call your own application functions. Enable **Client tools** under **Share → your embed → Security**.

```ts
import { navigationTool } from "@lookalike/widget/tools"

const clientTools = {
  navigateTo: navigationTool(),
}
```

Pass the object before starting a conversation:

- React: `<LookalikeWidget token="YOUR_TOKEN" clientTools={clientTools} />`
- Svelte: `<lookalike-widget token="YOUR_TOKEN" {clientTools}></lookalike-widget>`
- Vue: `<lookalike-widget token="YOUR_TOKEN" :clientTools.prop="clientTools" />`
- JavaScript: after `await customElements.whenDefined("lookalike-widget")`, assign `widget.clientTools = clientTools`.

`navigationTool()` allows HTTP(S) navigation within the current origin. Supply `navigate: (url) => router.push(url)` to use your router, or `allowedOrigins: ["https://help.example.com"]` to allow external destinations.

<details>
<summary>Define a custom tool</summary>

```ts
import { defineTool } from "@lookalike/widget/tools"
import { cart } from "./cart"

const clientTools = {
  addToCart: defineTool({
    description: "Add a product to the visitor's cart when they ask to buy it.",
    parameters: {
      type: "object",
      properties: { sku: { type: "string", minLength: 1 } },
      required: ["sku"],
      additionalProperties: false,
    },
    async handler({ sku }) {
      await cart.add(sku)
      return "Added to the cart."
    },
  }),
}
```

`defineTool` infers argument types from JSON Schema draft 7 and validates arguments before calling your handler. Return a string or JSON-serializable result; throw to report a failed action. `CLIENT_TOOLS` also exports `navigateTo` and `captureLead` schema presets for your own handlers.

Tool descriptions and schemas go to the avatar; handlers stay in your page. Replacing `clientTools` replaces the registered handlers. Schema changes take effect in the next conversation. Up to 16 tools are allowed, with each complete spec at most 4,096 characters and its description at most 500 characters.

</details>

## Advanced

### Conversation controls

The Web Component exposes these methods. Get its element with Svelte's `bind:this`, a Vue template ref, or `document.querySelector("lookalike-widget")`. In React, it is `event.currentTarget` inside `onEvent`. Wait for `lookalike:ready` before calling commands.

| Method | Behavior |
| --- | --- |
| `start(mode?)` / `stop()` | Start or end a conversation |
| `sendMessage(text)` | Send a user turn; starts a text conversation if needed |
| `setMode(mode)` | Switch conversation mode |
| `setMuted(boolean)` | Mute or unmute the visitor's microphone |
| `expand()` / `minimize()` | Expand or minimize without ending a live session |
| `injectContext(text)` | Add silent context to a live conversation |
| `speak(text)` | Have the avatar say text verbatim in a live conversation |

### Session customization

Enable the matching permissions under **Share → your embed → Security**: **Custom greeting**, **Dynamic variables**, and **Page context**.

```js
widget.addEventListener("lookalike:ready", () => {
  widget.update({
    overrides: {
      firstMessage: "Welcome! What can I help you find?",
      dynamicVariables: { currentPage: "/pricing" },
      systemPromptAddition: "The visitor is viewing the pricing page.",
    },
  })
})
```

Overrides apply to the next conversation. Use `injectContext` to supply context during an active one.

<details>
<summary>Create and manage a widget programmatically</summary>

Use `createWidget` when you need to mount outside a component tree or manage the widget's lifetime yourself.

```ts
import { createWidget } from "@lookalike/widget"

const widget = createWidget({
  token: "YOUR_TOKEN",
  position: "inline",
  target: "#chat-container",
})

widget.on("message", ({ role, content }) => console.log(role, content))
widget.sendMessage("Tell me about your products.")

// When your integration is removed:
widget.destroy()
```

`target` accepts a selector or an element. Floating widgets mount under `document.body`. The returned widget queues commands until ready and uses event names without the `lookalike:` prefix. `on` returns an unsubscribe function.

`update` replaces theme or overrides, updates teaser text, and merges client tools. Use `update({ clientTools: undefined })` to clear tools. Recreate the instance for structural changes such as token or placement. Teaser configuration uses `{ teaser: { text, delaySeconds } }`.

</details>

## Hosting and security

Conversations run on `https://lookalike.com`. Set `origin` to use another Lookalike deployment; hosting the package yourself does not host the conversation service.

Voice and video require HTTPS or localhost and microphone permission. Your Permissions Policy must allow the microphone for the service origin. If you use a Content Security Policy, allow the service in `frame-src`, your script source in `script-src`, and the widget's injected styles in `style-src`.

Embed tokens are public. Restrict allowed domains in the dashboard. Keep account API keys and privileged operations on your server; tool argument validation does not authorize an action.

[Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
