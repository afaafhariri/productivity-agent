import { z } from 'zod'
import type { JsonValue } from '../json'
import type { ApprovalScope, Clock, Confirmation, Decision, Logger, SecretStore } from '../ports'
import { TaskSafety, type ApprovalPolicy } from './approvals'
import type { AgentTool, ToolContext, ToolResult, ToolSpec } from './types'

/** Backstop only: tools should paginate/truncate themselves well below this. */
export const DEFAULT_MAX_RESULT_CHARS = 20_000

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

export interface FieldError {
  loc: string
  msg: string
}

export class UnknownToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown tool: ${toolName}`)
  }
}

/** The model sent arguments that don't match the tool's input schema. */
export class ToolInputError extends Error {
  constructor(
    readonly toolName: string,
    readonly errors: FieldError[]
  ) {
    super(`Invalid input for ${toolName}`)
  }
}

/** The tool itself failed. Logged; the model only learns that it failed. */
export class ToolFailedError extends Error {
  constructor(
    readonly toolName: string,
    readonly cause: unknown
  ) {
    super(`Tool ${toolName} failed`)
  }
}

/** The run was stopped while this call was pending. */
export class ToolCancelledError extends Error {
  constructor(readonly toolName: string) {
    super(`Tool ${toolName} was cancelled`)
  }
}

export interface ToolRuntime {
  confirmation: Confirmation
  secrets: SecretStore
  clock: Clock
  logger: Logger
  maxResultChars?: number
  /** "Always allow" choices. Without one, nothing is ever always allowed. */
  approvals?: ApprovalPolicy
  /** This task's grants and untrusted reads. Without one, every call is its own task. */
  task?: TaskSafety
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>()

  register(...tools: AgentTool[]): this {
    for (const tool of tools) {
      if (!SNAKE_CASE.test(tool.name))
        throw new Error(`Tool name must be snake_case: "${tool.name}"`)
      if (this.tools.has(tool.name)) throw new Error(`Tool already registered: "${tool.name}"`)
      this.tools.set(tool.name, tool)
    }
    return this
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      jsonSchema: z.toJSONSchema(tool.inputSchema) as JsonValue,
      effect: tool.effect
    }))
  }

  /**
   * Validates, gates (for write tools), executes and size-bounds one tool call.
   * A rejected write is not an error: it returns `{ status: 'rejected', ... }`.
   */
  async call(
    name: string,
    rawInput: unknown,
    toolCallId: string,
    runtime: ToolRuntime,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new UnknownToolError(name)

    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      throw new ToolInputError(
        name,
        parsed.error.issues.map((issue) => ({ loc: issue.path.join('.'), msg: issue.message }))
      )
    }
    const input = parsed.data
    if (signal?.aborted) throw new ToolCancelledError(name)

    if (tool.effect === 'write') {
      const rejection = await this.approve(
        tool.name,
        tool.description,
        input,
        toolCallId,
        runtime,
        signal
      )
      if (rejection) return rejection
    }

    const ctx: ToolContext = {
      toolCallId,
      signal,
      secrets: runtime.secrets,
      clock: runtime.clock,
      logger: runtime.logger
    }
    let result: ToolResult
    try {
      result = await tool.execute(input, ctx)
    } catch (error) {
      throw new ToolFailedError(name, error)
    }
    if (!tool.trustedOutput) runtime.task?.noteUntrustedRead(name)
    return bound(result, runtime.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS)
  }

  /**
   * Runs the approval gate for a write. Resolves to a `rejected` result, or undefined when the
   * call may go ahead. Earlier grants count only while the task has read nothing untrusted.
   */
  private async approve(
    name: string,
    description: string,
    input: unknown,
    toolCallId: string,
    runtime: ToolRuntime,
    signal?: AbortSignal
  ): Promise<ToolResult | undefined> {
    const task = runtime.task ?? new TaskSafety()
    if (!task.tainted) {
      const scope: 'task' | 'always' | undefined = task.isGrantedForTask(name)
        ? 'task'
        : (await runtime.approvals?.isAlwaysAllowed(name))
          ? 'always'
          : undefined
      if (scope) {
        runtime.logger.info('tool allowed by an earlier grant', { tool: name, toolCallId, scope })
        runtime.confirmation.notifyAutoApproved?.(toolCallId, name, scope)
        return undefined
      }
    }

    const scopes = task.offeredScopes()
    const decision: Decision = await runtime.confirmation.request(
      {
        toolCallId,
        toolName: name,
        description,
        input: toJson(input),
        scopes,
        untrustedSources: task.untrustedSources
      },
      signal
    )
    // Re-check after waiting: a stopped run must never execute the tool.
    if (signal?.aborted) throw new ToolCancelledError(name)
    if (!decision.approved) {
      runtime.logger.info('tool rejected by user', { tool: name, toolCallId })
      return { status: 'rejected', reason: decision.reason ?? 'The user rejected this action.' }
    }
    // Only a scope we offered counts; anything else is a one-off approval.
    const scope: ApprovalScope =
      decision.scope && scopes.includes(decision.scope) ? decision.scope : 'once'
    if (scope === 'task') task.grantForTask(name)
    if (scope === 'always') await runtime.approvals?.allowAlways(name)
    runtime.logger.info('tool approved by user', { tool: name, toolCallId, scope })
    return undefined
  }
}

/** The normalised input (defaults filled in) as plain JSON, as the user sees it for approval. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

function bound(result: ToolResult, maxChars: number): ToolResult {
  const serialized = JSON.stringify(result)
  const length = [...serialized].length
  if (length <= maxChars) return result
  return {
    truncated: true,
    note: `Result was ${length} characters and was cut to ${maxChars}. Ask for a narrower query or the next page.`,
    preview: [...serialized].slice(0, maxChars).join('')
  }
}
