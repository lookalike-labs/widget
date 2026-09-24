/** Validate the artifact consumers install, independently of monorepo aliases. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { runInContext, runInNewContext } from "node:vm"
import { build } from "esbuild"
import { JSDOM } from "jsdom"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const consumer = await mkdtemp(join(tmpdir(), "lookalike-packed-consumer-"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
function run(command, args, cwd = consumer) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

try {
  const [packed] = JSON.parse(run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", consumer], packageRoot))
  const files = new Set(packed.files.map(file => file.path))
  for (const path of ["LICENSE", "README.md", "package.json", "dist/loader.global.js"])
    assert.ok(files.has(path), `npm tarball is missing ${path}`)
  assert.ok([...files].every(path => !/(^|\/)(node_modules|test|tests|\.env)(\/|$)/.test(path)), "tarball contains development-only files")
  assert.ok([...files].every(path => !path.startsWith("examples/")), "tarball contains exploratory examples")
  // Source maps are public too: only package source and the bundled validator
  // belong in them, never application source or machine-specific paths.
  for (const path of files) {
    assert.ok(/^(dist\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/.test(path), `unexpected public file: ${path}`)
    const contents = await readFile(join(packageRoot, path), "utf8")
    assert.doesNotMatch(contents, /\/Users\/|\/home\//, `private reference in ${path}`)
    if (path.endsWith(".map")) {
      for (const source of JSON.parse(contents).sources) {
        assert.ok(source.startsWith("../src/") || source.startsWith("../node_modules/@cfworker/json-schema/"), `unexpected mapped source: ${source}`)
      }
    }
  }


  const sourceManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  const tarball = `file:${join(consumer, packed.filename)}`
  const consumerManifest = { name: "widget-consumer-check", private: true, type: "module", dependencies: { [sourceManifest.name]: tarball } }
  // Reuse the standalone lock's dependency versions and integrity hashes.
  // A fresh npm ci caches tarballs, but need not cache registry metadata.
  const lock = JSON.parse(await readFile(join(packageRoot, "package-lock.json"), "utf8"))
  lock.name = consumerManifest.name
  lock.packages[""] = consumerManifest
  lock.packages[`node_modules/${sourceManifest.name}`] = { ...sourceManifest, resolved: tarball }
  await writeFile(join(consumer, "package.json"), JSON.stringify(consumerManifest))
  await writeFile(join(consumer, "package-lock.json"), JSON.stringify(lock))
  run(npm, ["ci", "--offline", "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund"])

  // Reuse exact installed dev-tool versions; no registry access or monorepo
  // widget alias. The widget itself above is installed solely from its tarball.
  for (const dependency of ["react", "react-dom", "@types/react", "@types/react-dom"]) {
    const destination = join(consumer, "node_modules", dependency)
    await mkdir(dirname(destination), { recursive: true })
    await symlink(dirname(require.resolve(`${dependency}/package.json`)), destination, "junction")
  }

  const installed = join(consumer, "node_modules/@lookalike/widget")
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
  async function checkTargets(value) {
    if (typeof value === "string") {
      assert.ok(files.has(value.replace(/^\.\//, "")), `export target not shipped: ${value}`)
      await readFile(join(installed, value))
    } else {
      for (const entry of Object.values(value)) await checkTargets(entry)
    }
  }
  await checkTargets(manifest.exports)
  const imports = Object.keys(manifest.exports).filter(key => !key.includes("*") && key !== "./loader").map(key => key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`)
  const esm = imports.map(name => `await import(${JSON.stringify(name)});`).join("\n")
  const cjs = imports.map(name => `require(${JSON.stringify(name)});`).join("\n")
  run(process.execPath, ["--input-type=module", "-e", esm])
  run(process.execPath, ["--input-type=commonjs", "-e", cjs])
  console.log("✓ Packed ESM and CommonJS public imports work without a DOM")

  const types = `import { createWidget, resolveAndCreateWidget, type WidgetConfig } from '@lookalike/widget';
import { defineLookalikeWidget } from '@lookalike/widget/element';
import { LookalikeWidget, type LookalikeWidgetProps } from '@lookalike/widget/react';
import { CLIENT_TOOLS, defineTool, navigationTool } from '@lookalike/widget/tools';
import { command } from '@lookalike/widget/protocol';
import { attachDragHarness } from '@lookalike/widget/drag';
const typedTool = defineTool({
  description: 'Add a product',
  parameters: {
    type: 'object',
    properties: {
      sku: { type: 'string' },
      priority: { enum: ['normal', 'urgent'] },
      note: { type: 'string', default: 'optional' },
    },
    required: ['sku', 'priority'],
    additionalProperties: false,
  },
  handler(args) {
    const sku: string = args.sku;
    const priority: 'normal' | 'urgent' = args.priority;
    const note: string | undefined = args.note;
    // @ts-expect-error Schema says sku is a string.
    const bad: number = args.sku;
    // @ts-expect-error JSON Schema defaults do not make an optional field required.
    const requiredNote: string = args.note;
    // @ts-expect-error Closed schema has no extra property.
    args.missing;
    return [sku, priority, note];
  },
});
const toolsConfig: WidgetConfig = { token: 'test', clientTools: { add: typedTool, navigateTo: navigationTool() } };
void toolsConfig;
const config: WidgetConfig = { token: 'public-token', modes: ['text'] };
const widget = createWidget(config);
widget.on('message', message => { const text: string = message.content; console.log(text); });
const element = document.createElement('lookalike-widget');
element.clientTools = {};
element.addEventListener('lookalike:message', event => { const text: string = event.detail.content; console.log(text); });
element.addEventListener('lookalike:call', event => { event.detail.config.modes = ['text']; });
const onEvent: NonNullable<LookalikeWidgetProps['onEvent']> = event => {
  if (event.type === 'lookalike:connect') {
    const mode: 'text' | 'audio' | 'video' = event.detail.mode;
    console.log(mode);
    // @ts-expect-error A connect event does not carry message content.
    console.log(event.detail.content);
  } else if (event.type === 'lookalike:message') {
    const content: string = event.detail.content;
    console.log(content);
  } else if (event.type === 'lookalike:disconnect') {
    const detail: undefined = event.detail;
    console.log(detail);
  }
};
void onEvent;
void [resolveAndCreateWidget(config), defineLookalikeWidget, LookalikeWidget, CLIENT_TOOLS, command, attachDragHarness];
`
  await writeFile(join(consumer, "consumer.mts"), types)
  await writeFile(join(consumer, "consumer.cts"), types)
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["react", "react-dom"] },
    files: ["consumer.mts", "consumer.cts"],
  }))
  const typescriptManifestPath = require.resolve("typescript/package.json")
  const typescriptManifest = JSON.parse(await readFile(typescriptManifestPath, "utf8"))
  run(process.execPath, [join(dirname(typescriptManifestPath), typescriptManifest.bin.tsc), "-p", join(consumer, "tsconfig.json")])
  console.log("✓ NodeNext TypeScript ESM and CommonJS consumers resolve public declarations")

  const toolEntry = join(consumer, "tools-browser.mjs")
  await writeFile(toolEntry, `import { defineTool } from '@lookalike/widget/tools';
    const tool = defineTool({description:'Echo', parameters:{type:'object', properties:{text:{type:'string'}}, required:['text']}, handler:({text})=>text});
    globalThis.validResult = tool.handler({text:'hello'});
    try { tool.handler({text:42}); } catch { globalThis.rejected = true; }`)
  const toolBundle = await build({entryPoints:[toolEntry], bundle:true, platform:'browser', format:'iife', write:false, logLevel:'silent'})
  const sandbox = { URL, validResult: undefined, rejected: false }
  runInNewContext(toolBundle.outputFiles[0].text, sandbox, {contextCodeGeneration:{strings:false, wasm:false}})
  assert.equal(sandbox.validResult, 'hello')
  assert.equal(sandbox.rejected, true, 'bundled tools validate without eval or Function')
  console.log('✓ Bundled tool validation works with dynamic code generation disabled')

  const entries = {
    root: "import '@lookalike/widget';",
    element: "import '@lookalike/widget/element';",
    loader: "import '@lookalike/widget/loader';",
    react: `import { LookalikeWidget } from '@lookalike/widget/react';
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      const root = createRoot(document.body.appendChild(document.createElement('main')));
      const renderWidget = (prefix) => flushSync(() => root.render(createElement(LookalikeWidget, {
        token: 'consumer-token', position: globalThis.fixturePosition, modes: ['text'],
        theme: {accent: 'red'},
        draggable: false,
        onEvent: event => {
          globalThis.lastEvent = event;
          if (event.type === 'lookalike:message') globalThis.receivedMessage = {...event.detail, content: prefix + event.detail.content};
          if (event.type === 'lookalike:transcript') globalThis.receivedTranscript = event.detail;
        },
      })));
      renderWidget('');
      globalThis.updateCallback = () => renderWidget('updated: ');
      globalThis.unmountWidget = () => flushSync(() => root.unmount());`,
  }
  entries.reactFloating = entries.react
  entries.reactDefault = entries.react
  for (const [name, contents] of Object.entries(entries)) {
    const entry = join(consumer, `${name}.mjs`)
    await writeFile(entry, contents)
    const result = await build({ entryPoints: [entry], absWorkingDir: consumer, bundle: true, treeShaking: true, minify: true, platform: "browser", format: "iife", write: false, tsconfigRaw: {}, logLevel: "silent" })
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://customer.example/", runScripts: "outside-only", pretendToBeVisual: true })
    try {
      dom.window.fixturePosition = name === "reactDefault" ? undefined : name === "reactFloating" ? "floating" : "inline"
      dom.window.fetch = async () => new Response(JSON.stringify({ modes: ["text"], position: "inline", draggable: true, teaser: { text: "Saved preference", delaySeconds: 3 } }))
      dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
      let mountedConfig
      dom.window.document.addEventListener("lookalike:call", event => { mountedConfig = event.detail.config })
      runInContext(result.outputFiles[0].text, dom.getInternalVMContext())
      assert.ok(dom.window.customElements.get("lookalike-widget"), `${name} consumer bundle dropped custom element registration`)
      if (name === "loader") assert.equal(typeof dom.window.Lookalike, "function", "optimized loader imports must install the command API")
      if (name.startsWith("react")) {
        await new Promise(resolve => setImmediate(resolve))
        const element = dom.window.document.querySelector("lookalike-widget")
        const host = dom.window.document.querySelector("[data-lookalike-host]")
        assert.ok(element)
        assert.ok(host, "packed React wrapper must mount its widget")
        assert.equal(mountedConfig.position, dom.window.fixturePosition, "React placement must come from its props")
        if (name === "reactFloating" || name === "reactDefault") {
          assert.equal(host.parentElement, dom.window.document.body, "floating override mounts on the body, outside the React element")
          assert.equal(element.querySelector("[data-lookalike-host]"), null)
        } else {
          assert.equal(host.parentElement, element)
        }
        assert.equal(mountedConfig.draggable, false, "React must pass false as a boolean");
        assert.equal(mountedConfig.teaser, undefined, "saved teaser settings must not reach React widgets");
        assert.equal(mountedConfig.theme.accent, "red", "React object props must reach widget configuration")
        element.dispatchEvent(new dom.window.CustomEvent("lookalike:message", { detail: { role: "assistant", content: "Consumer callback" } }))
        assert.equal(dom.window.receivedMessage.content, "Consumer callback")
        dom.window.updateCallback()
        element.dispatchEvent(new dom.window.CustomEvent("lookalike:message", { detail: { role: "assistant", content: "latest" } }))
        assert.equal(dom.window.receivedMessage.content, "updated: latest", "callback changes must not retain stale closures")
        element.dispatchEvent(new dom.window.CustomEvent("lookalike:transcript", { detail: { role: "assistant", content: "streaming", messageId: "test", timestamp: 0 } }))
        assert.equal(dom.window.receivedTranscript.content, "streaming")
        for (const type of ["call", "ready", "connect", "disconnect", "message", "transcript", "mode-change", "speaking-change", "resize", "tool-call", "error"]) {
          const event = new dom.window.CustomEvent(`lookalike:${type}`, { detail: {} })
          element.dispatchEvent(event)
          assert.equal(dom.window.lastEvent, event, `onEvent must forward the original ${type} event`)
        }
        dom.window.unmountWidget()
        const lastEvent = dom.window.lastEvent
        element.dispatchEvent(new dom.window.CustomEvent("lookalike:connect", { detail: { mode: "text" } }))
        assert.equal(dom.window.lastEvent, lastEvent, "unmount must remove the shared event handler")
        assert.equal(dom.window.document.querySelector("lookalike-widget"), null)
        assert.equal(host.isConnected, false, "React unmount must destroy the widget")
        assert.equal(dom.window.document.querySelector("[data-lookalike-host]"), null)
      }
    } finally {
      dom.window.close()
    }
  }
  console.log("✓ Optimized root, /element and React bundles preserve element registration")
  const loaderSource = await readFile(join(installed, "dist/loader.global.js"), "utf8")
  const originEntry = join(consumer, "origin-consumer.mjs")
  await writeFile(originEntry, `import { resolveAndCreateWidget } from '@lookalike/widget';
    globalThis.createTestWidget = () => resolveAndCreateWidget({token: 'origin-test', modes: ['text']});`)
  const originBundle = await build({ entryPoints: [originEntry], absWorkingDir: consumer, bundle: true, minify: true, platform: "browser", format: "iife", write: false, tsconfigRaw: {}, logLevel: "silent" })
  const originCases = [
    { script: "https://customer.example/assets/app.js", expected: "https://lookalike.com" },
    { script: "https://customer.example/vendor/loader.global.js", expected: "https://lookalike.com" },
    { script: "https://selfhost.example/widget/v1.js", expected: "https://selfhost.example" },
    { script: "https://unpkg.com/@lookalike/widget@2", expected: "https://lookalike.com" },
    { script: "https://cdn.jsdelivr.net/widget/v1.js", expected: "https://lookalike.com" },
  ]
  for (const [surface, source] of [["bundle", originBundle.outputFiles[0].text], ["loader", loaderSource]]) {
    for (const { script: src, expected } of originCases) {
      const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://customer.example/", runScripts: "outside-only", pretendToBeVisual: true })
      try {
        const requests = []
        dom.window.fetch = async input => { requests.push(input); return new Response(JSON.stringify({ modes: ["text"] })) }
        dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
        const script = dom.window.document.createElement("script")
        script.src = src
        Object.defineProperty(dom.window.document, "currentScript", { configurable: true, value: script })
        runInContext(source, dom.getInternalVMContext())
        // The asynchronous init runs after classic-script evaluation has ended.
        Object.defineProperty(dom.window.document, "currentScript", { configurable: true, value: null })
        let widget
        if (surface === "bundle") widget = await dom.window.createTestWidget()
        else {
          dom.window.Lookalike("init", { token: "origin-test", modes: ["text"] })
          await new Promise(resolve => setImmediate(resolve))
        }
        assert.deepEqual(requests, [], `${surface} must mount without a configuration request`)
        const frame = dom.window.document.querySelector("[data-lookalike-host]")?.shadowRoot?.querySelector("iframe")
        assert.ok(frame)
        assert.equal(new URL(frame.src).origin, expected, `${surface} iframe origin for ${src}`)
        if (widget) widget.destroy()
        else dom.window.Lookalike("shutdown")
        assert.equal(dom.window.document.querySelector("[data-lookalike-host]"), null)
      } finally {
        dom.window.close()
      }
    }
  }
  console.log("✓ Classic customer bundles and copied/CDN loaders use hosted URLs; self-hosted loader paths retain their origin")
  const loaderDOM = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://customer.example/", runScripts: "outside-only", pretendToBeVisual: true })
  try {
    let requests = 0
    const errors = []
    loaderDOM.window.addEventListener("lookalike:error", event => errors.push(event))
    loaderDOM.window.fetch = async () => { requests++; throw new Error("Unexpected config fetch") }
    runInContext(`window.Lookalike = function() { (window.Lookalike.q ??= []).push(arguments) };
      Lookalike('init', {token: 'test'});
      Lookalike('start', 'text');
      Lookalike('shutdown');`, loaderDOM.getInternalVMContext())
    runInContext(loaderSource, loaderDOM.getInternalVMContext())
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(typeof loaderDOM.window.Lookalike, "function", "browser loader must expose the documented global API")
    assert.ok(loaderDOM.window.customElements.get("lookalike-widget"))
    assert.equal(requests, 0, "queued initialization must never fetch config")
    assert.equal(loaderDOM.window.document.querySelector("[data-lookalike-host]"), null)
    assert.deepEqual(errors, [], "intentional shutdown must not emit an initialization error")
  } finally {
    loaderDOM.window.close()
  }
  console.log("✓ Tarball contains license, every export target and a working browser loader")
} finally {
  await rm(consumer, { recursive: true, force: true })
}
