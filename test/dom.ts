import { JSDOM } from "jsdom"

/** A fresh browser realm with no resource loading or live service calls. */
export function installDOM() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://customer.example/",
    pretendToBeVisual: true,
  })
  const values = {
    window: dom.window,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    document: dom.window.document,
    location: dom.window.location,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLIFrameElement: dom.window.HTMLIFrameElement,
    customElements: dom.window.customElements,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  return {
    window: dom.window,
    document: dom.window.document,
    restore() {
      dom.window.close()
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}
