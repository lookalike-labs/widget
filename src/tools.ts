import type { FromSchema, JSONSchema } from "json-schema-to-ts"
import type { ClientToolDef } from "./core/types"
import { validateToolArguments } from "./core/tool-validation"

export interface ClientToolSpec {
  /** LLM-facing description: when to call it. */
  description: string
  /** JSON-schema `parameters` object, as passed to the LLM tool definition. */
  parameters: {
    type: "object"
    properties?: Record<string, unknown>
    required?: readonly string[]
    [keyword: string]: unknown
  }
}

export const CLIENT_TOOLS = {
  navigateTo: {
    description:
      "Navigate the visitor's browser to a page on this website. Use when the visitor wants to see a page, or when showing it answers their question better than describing it.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            'The destination. Prefer a relative path like "/pricing" for pages on this website; a full URL opens an external site.',
        },
      },
      required: ["url"],
    },
  },
  captureLead: {
    description:
      "Save the visitor's contact details as a sales lead. Call when the visitor shares contact information and wants a follow-up, a quote, or a demo — after you have their name or email. Never invent details they did not give.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The visitor's name, if given." },
        email: { type: "string", description: "The visitor's email address." },
        phone: { type: "string", description: "The visitor's phone number, if given." },
        note: {
          type: "string",
          description: "One sentence on what they're interested in, in their words.",
        },
      },
      required: ["email"],
    },
  },
} as const satisfies Record<string, ClientToolSpec>

export type ClientToolName = keyof typeof CLIENT_TOOLS

export const CLIENT_TOOL_NAMES = Object.keys(CLIENT_TOOLS) as ClientToolName[]

export function isClientToolName(name: string): name is ClientToolName {
  return Object.hasOwn(CLIENT_TOOLS, name)
}

/** Define a JSON Schema tool with inferred, validated handler arguments. */
export function defineTool<
  const S extends JSONSchema,
  Args = FromSchema<S, { keepDefaultedPropertiesOptional: true }>,
>(definition: {
  description: string
  parameters: S & ClientToolSpec["parameters"]
  handler: (args: NoInfer<Args>) => unknown | Promise<unknown>
}): ClientToolDef {
  return {
    description: definition.description,
    parameters: definition.parameters,
    handler(args) {
      assertToolArguments<Args>(definition.parameters, args)
      return definition.handler(args)
    },
  }
}

function assertToolArguments<Args>(
  schema: ClientToolSpec["parameters"], args: unknown,
): asserts args is Args {
  validateToolArguments(schema, args)
}

export interface NavigationToolOptions {
  /** Override browser navigation, for example with your framework's router. */
  navigate?: (url: string) => unknown | Promise<unknown>
  /** Additional HTTP(S) origins permitted alongside the current page's origin. */
  allowedOrigins?: readonly string[]
}

/** Navigate within this site by default; external destinations require an explicit origin. */
export function navigationTool(options: NavigationToolOptions = {}): ClientToolDef {
  return defineTool({
    ...CLIENT_TOOLS.navigateTo,
    async handler({ url }) {
      const destination = new URL(url, window.location.href)
      if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password) {
        throw new Error("Navigation requires an HTTP(S) URL without credentials")
      }
      const sameOrigin = destination.origin === window.location.origin
      const allowed = options.allowedOrigins?.some(origin => new URL(origin).origin === destination.origin)
      if (!sameOrigin && !allowed) throw new Error(`Navigation to ${destination.origin} is not allowed`)
      // A path beginning with // would become an external URL if reparsed.
      const target = sameOrigin && !destination.pathname.startsWith("//")
        ? destination.pathname + destination.search + destination.hash
        : destination.href
      if (options.navigate) await options.navigate(target)
      else window.location.assign(destination.href)
      return `Navigated to ${target}`
    },
  })
}
