# Changelog

## 3.0.0

First open-source release. The source lives at https://github.com/lookalike-labs/widget. Versions before 3.0.0 have no changelog entries.

### Breaking changes since 2.0.1

- The React component takes one `onEvent` callback. It replaces `onReady`, `onConnect`, `onDisconnect`, `onMessage`, `onModeChange`, `onSpeakingChange`, `onResize`, and `onToolCall`. Switch on `event.type`, which uses the same `lookalike:*` names as the DOM events, and read the payload from `event.detail`.
- `useLookalike` and its types are gone. Use `<LookalikeWidget>` to embed the widget, or `createTransport` if you render your own iframe.
- `position` is the only placement option. The `variant` attribute and prop are gone.
- `persistAnchorKey` and `persist-anchor-key` are gone. An embedded widget no longer remembers a dragged position between page loads.
- Floating widgets are draggable by default. Set `draggable="false"` in HTML or `draggable={false}` in React to keep a fixed corner.
- `fetchWidgetConfig`, `mergeWidgetConfig`, and the `ServerWidgetConfig` type are gone. The widget mounts in one step and reads its permitted modes from the avatar data.
- Appearance comes from your embed code and the SDK defaults. Placement, dragging, and teaser settings saved in the dashboard no longer change an installed widget. The service still enforces allowed modes.

### Added

- `@lookalike/widget/element` exports the custom element on its own, and `@lookalike/widget/loader` is the script-tag bundle.
- `defineTool` infers the handler's argument types from the tool's JSON Schema.
- `navigationTool` navigates to HTTP(S) URLs on the same origin or on origins listed in `allowedOrigins`. Pass `navigate` to route through your router instead of a full page load.
- The widget validates client-tool arguments against their JSON Schema before it runs a handler. A failed check returns a tool error to the agent.
- `theme.accent` and `theme["accent-foreground"]` color the send button. Passing `{}` restores the defaults.
- `lookalike:transcript` fires with streaming text updates. `lookalike:message` fires once with the complete message after the stream closes.

### Fixed

- Tool schemas reach the agent intact, including root-level constraints and local `$ref`s.
- Replacing tool properties on the React component or the custom element removes the old handlers.
- `draggable="false"` parses correctly in HTML and React.
- Removing an element or loader instance cancels a pending mount. The widget drops commands sent after teardown and reports initialization errors through `lookalike:error`.
- The widget sends its initial configuration before any queued session-start commands.
- Production bundles keep the custom-element registration after the build moved from tsup to tsdown.
- The ESM and CommonJS builds ship matching type declarations.
- The widget builds the branding link with DOM APIs and accepts only HTTP(S) URLs for it. The iframe has a name, and the teaser works from the keyboard.
- Bundles you host yourself default to the service at lookalike.com, and React placement props override the defaults.
