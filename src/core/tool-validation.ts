import { Validator } from "@cfworker/json-schema"

const validators = new WeakMap<object, { json: string; validator: Validator }>()

/** Validate before running host-page code. Schemas are owned by the embedding app. */
export function validateToolArguments(schema: object, args: unknown): void {
  const json = JSON.stringify(schema)
  let cached = validators.get(schema)
  if (!cached || cached.json !== json) {
    // The validator annotates schemas while resolving references. Give it a
    // mutable JSON copy so it cannot alter the definition sent to the agent.
    cached = { json, validator: new Validator(JSON.parse(json), "7") }
    validators.set(schema, cached)
  }
  const result = cached.validator.validate(args)
  if (!result.valid) {
    const detail = result.errors.map(error => `${error.instanceLocation}: ${error.error}`).join("; ")
    throw new Error(`Invalid tool arguments: ${detail}`)
  }
}
