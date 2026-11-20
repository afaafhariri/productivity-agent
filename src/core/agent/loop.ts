/** The agent loop: model turn → tool calls (through the approval gate) → results → next turn. */
import { dynamicTool, streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import type { JsonValue } from '../json'
import { ModelError, modelErrorFrom } from '../llm/errors'
import {
  ToolCancelledError,
  ToolFailedError,
  ToolInputError,
  UnknownToolError,
  type ToolRegistry,
  type ToolRuntime
} from '../tools'
import { SYSTEM_PROMPT } from './prompt'

export const DEFAULT_MAX_STEPS = 8

/** How long to wait for the model's first or next chunk. Thinking models can be quiet a while. */
export const IDLE_TIMEOUT_MS = 90_000

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: JsonValue }
  | { type: 'tool_result'; toolCallId: string; toolName: string; result: JsonValue }

export type DoneReason = 'stop' | 'max_steps'

/** The user stopped the run. */
export class RunCancelledError extends Error {
  override readonly name = 'RunCancelledError'
}

export interface RunOptions {
  model: LanguageModel
  /** Shown in error messages, e.g. "model is overloaded". */
  modelId: string
  registry: ToolRegistry
  runtime: ToolRuntime
  /** Earlier turns plus the new user message. Completed turns are appended on success. */
  history: ModelMessage[]
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  instructions?: string
  maxSteps?: number
  idleTimeoutMs?: number
}

/** Delimits tool output so the model treats it as data (see SYSTEM_PROMPT). */
export function wrapUntrusted(toolName: string, result: unknown): JsonValue {
  return { tool: toolName, untrusted_content: (result ?? null) as JsonValue }
}

/**
 * Runs until the model answers without tool calls or `maxSteps` steps have run. Throws
 * RunCancelledError when `signal` aborts (a pending write is never executed) and ModelError
 * for failures the user should see. On success the run's messages are appended to `history`;
 * a stopped or failed run adds nothing, so history always stays valid for the next turn.
 */
export async function runAgent(options: RunOptions): Promise<DoneReason> {
  const { model, modelId, registry, runtime, history, signal, onEvent } = options
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const idle = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  let failure: unknown

  const result = streamText({
    model,
    instructions: options.instructions ?? SYSTEM_PROMPT,
    messages: history,
    tools: toAiTools(registry, runtime),
    stopWhen: stepCountIs(maxSteps),
    abortSignal: signal,
    timeout: { firstChunkMs: idle, chunkMs: idle },
    onError: ({ error }) => {
      failure = error
    }
  })

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        onEvent({ type: 'text_delta', text: part.text })
        break
      case 'tool-call':
        onEvent({
          type: 'tool_call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: (part.input ?? null) as JsonValue
        })
        break
      case 'tool-result':
        onEvent({
          type: 'tool_result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: (part.output ?? null) as JsonValue
        })
        break
      case 'tool-error':
        // The SDK reports bad input / unknown tools here and tells the model itself.
        if (part.error instanceof ToolCancelledError || signal.aborted) break
        onEvent({
          type: 'tool_result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: { status: 'error', error: 'invalid_input', message: 'The tool call was invalid.' }
        })
        break
      case 'error':
        failure ??= part.error
        break
      default:
        break
    }
  }

  if (signal.aborted) throw new RunCancelledError('The run was stopped.')
  if (failure !== undefined) {
    if (failure instanceof ModelError) throw failure
    runtime.logger.warn('model call failed', { error: describe(failure) })
    throw modelErrorFrom(failure, modelId)
  }

  const [response, steps] = await Promise.all([result.response, result.steps])
  history.push(...response.messages)
  const last = steps.at(-1)
  return steps.length >= maxSteps && last?.finishReason === 'tool-calls' ? 'max_steps' : 'stop'
}

/** Each registry tool as an AI SDK tool. Tool errors become results the model can react to. */
function toAiTools(registry: ToolRegistry, runtime: ToolRuntime): ToolSet {
  const tools: ToolSet = {}
  for (const spec of registry.specs()) {
    tools[spec.name] = dynamicTool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: async (input: unknown, { toolCallId, abortSignal }) => {
        try {
          return await registry.call(spec.name, input, toolCallId, runtime, abortSignal)
        } catch (error) {
          if (error instanceof ToolCancelledError) throw error
          if (error instanceof UnknownToolError) {
            return { status: 'error', error: 'unknown_tool', message: `No tool named ${spec.name}.` }
          }
          if (error instanceof ToolInputError) {
            return { status: 'error', error: 'invalid_input', details: error.errors as unknown as JsonValue }
          }
          if (error instanceof ToolFailedError) {
            runtime.logger.error('tool failed', { tool: spec.name, toolCallId, error: describe(error.cause) })
            return { status: 'error', error: 'tool_failed', message: 'The tool failed to run.' }
          }
          throw error
        }
      },
      toModelOutput: ({ output }) => ({ type: 'json', value: wrapUntrusted(spec.name, output) })
    })
  }
  return tools
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
