import type { z } from 'zod'
import type { JsonValue } from '../json'
import type { Clock, Logger, SecretStore } from '../ports'

/** Structured, JSON-serialisable tool output. Never a pre-formatted string for the user. */
export type ToolResult = JsonValue

export type ToolEffect = 'read' | 'write'

/** What a tool may use while executing. Built per call by the registry. */
export interface ToolContext {
  toolCallId: string
  signal?: AbortSignal
  secrets: SecretStore
  clock: Clock
  logger: Logger
}

export interface AgentTool<I extends z.ZodType = z.ZodType> {
  /** snake_case, e.g. github_list_pull_requests */
  name: string
  /** Written for the model: when to use it, what it returns. */
  description: string
  /** Validated before the tool runs; JSON Schema for the model is generated from it. */
  inputSchema: I
  /** `write` changes state outside the app and always needs the user's approval. */
  effect: ToolEffect
  /**
   * Set only when the output can't carry text from other people (e.g. our own receipt).
   * Otherwise reading it marks the task as having seen untrusted content.
   */
  trustedOutput?: boolean
  execute(input: z.output<I>, ctx: ToolContext): Promise<ToolResult>
}

/** Keeps the input type inferred from the schema. */
export function defineTool<I extends z.ZodType>(tool: AgentTool<I>): AgentTool<I> {
  return tool
}

/** What the model sees for a tool (plus `effect`, which providers ignore). */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: z.ZodType
  jsonSchema: JsonValue
  effect: ToolEffect
}
