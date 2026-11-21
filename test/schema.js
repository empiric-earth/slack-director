// The JSON Schema subset the RPC contract uses, as one predicate.
//
// The contract's schemas are plain JSON Schema, and the suite carries no
// dependency, so this reads the subset the contract uses: a `type` (a name or a
// list of them), `properties` with `required`, `items`, and
// `additionalProperties: false`. It answers undefined, or why the value misses.

export function schemaProblem(schema, value, at = "value") {
  if (schema === undefined) return undefined
  if (Array.isArray(schema.type)) {
    const problems = schema.type.map((type) => schemaProblem({ ...schema, type }, value, at))
    return problems.some((problem) => problem === undefined) ? undefined : `${at} is none of ${schema.type.join(", ")}`
  }
  const isObject = (candidate) => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
  switch (schema.type) {
    case "object": {
      if (!isObject(value)) return `${at} is not an object`
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) return `${at} has no ${key}`
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(value, key)) continue
        const problem = schemaProblem(child, value[key], `${at}.${key}`)
        if (problem) return problem
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(schema.properties ?? {}, key)) return `${at} carries an undeclared ${key}`
        }
      }
      return undefined
    }
    case "array": {
      if (!Array.isArray(value)) return `${at} is not an array`
      for (const [index, entry] of value.entries()) {
        const problem = schemaProblem(schema.items, entry, `${at}[${index}]`)
        if (problem) return problem
      }
      return undefined
    }
    case "string":
      return typeof value === "string" ? undefined : `${at} is not a string`
    case "integer":
      return Number.isInteger(value) ? undefined : `${at} is not an integer`
    case "boolean":
      return typeof value === "boolean" ? undefined : `${at} is not a boolean`
    case "null":
      return value === null ? undefined : `${at} is not null`
    default:
      return undefined
  }
}
