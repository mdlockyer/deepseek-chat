import type { ToolDefinition } from './types.js'

const TOOL_SUMMARY_SCHEMA = {
  type: 'string',
  description:
    "Plain, active 1-sentence summary (6-18 words, in the user's language) explaining what this tool call is doing and why, using ordinary words rather than compressed shorthand. Shown live in the activity indicator; always emit this field first.",
} as const

/**
 * Prepends a required `summary` parameter as the first property on a client tool schema so it
 * streams before large payloads (such as long code blocks or HTML documents). Pure; never mutates.
 */
export const withSummaryParam = <T extends ToolDefinition>(tool: T): T => {
  const schema = tool.input_schema
  const rawProps =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {}
  const properties = Object.hasOwn(rawProps, 'summary')
    ? rawProps
    : { summary: TOOL_SUMMARY_SCHEMA, ...rawProps }
  const rawRequired = Array.isArray(schema.required)
    ? schema.required.filter((item: unknown): item is string => typeof item === 'string')
    : []
  const required = rawRequired.includes('summary') ? rawRequired : ['summary', ...rawRequired]
  return {
    ...tool,
    input_schema: {
      ...schema,
      properties,
      required,
    },
  }
}
