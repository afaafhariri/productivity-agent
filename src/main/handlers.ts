/**
 * IPC request handlers, with every payload validated by zod. No Electron imports, so they can
 * be tested directly; `ipc.ts` registers them with `ipcMain`.
 */
import { z } from 'zod'
import { ServiceError, type AgentService } from '../core/service'
import { Channels, type AgentInfo, type Result } from '../shared/ipc-contract'

const Id = z.string().min(1).max(128)
const SecretName = z.enum(['gemini_api_key', 'anthropic_api_key', 'github_token'])
const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const Decision = z.discriminatedUnion('approved', [
  z
    .object({ approved: z.literal(true), scope: z.enum(['once', 'task', 'always']).optional() })
    .strict(),
  z.object({ approved: z.literal(false), reason: z.string().max(500).optional() }).strict()
])

const schemas = {
  [Channels.info]: z.undefined(),
  [Channels.settings]: z.undefined(),
  [Channels.setSecret]: z.object({ name: SecretName, value: z.string().max(4096) }).strict(),
  [Channels.deleteSecret]: z.object({ name: SecretName }).strict(),
  [Channels.startRun]: z
    .object({ conversationId: Id, text: z.string().min(1).max(32_000) })
    .strict(),
  [Channels.cancelRun]: z.object({ runId: Id }).strict(),
  [Channels.respond]: z.object({ runId: Id, toolCallId: Id, decision: Decision }).strict(),
  [Channels.revokeAlways]: z.object({ toolName: ToolName }).strict()
} as const

export type Handler = (payload: unknown) => Promise<Result<unknown>>

export function createHandlers(
  service: AgentService | null,
  info: AgentInfo
): Record<string, Handler> {
  const handle =
    <S extends z.ZodType>(
      schema: S,
      run: (input: z.output<S>, agent: AgentService) => unknown | Promise<unknown>
    ) =>
    async (payload: unknown): Promise<Result<unknown>> => {
      const parsed = schema.safeParse(payload)
      // Never echo the payload back: it may contain a secret.
      if (!parsed.success) return fail('invalid_input', 'Invalid request')
      if (!service) return fail('unavailable', info.configError ?? 'The agent is not running')
      try {
        const value = await run(parsed.data, service)
        return { ok: true, value: value ?? null }
      } catch (error) {
        if (error instanceof ServiceError) return fail(error.code, error.message)
        return fail('internal', 'Something went wrong. See logs.')
      }
    }

  return {
    [Channels.info]: async (payload) =>
      schemas[Channels.info].safeParse(payload).success
        ? { ok: true, value: info }
        : fail('invalid_input', 'Invalid request'),
    [Channels.settings]: handle(schemas[Channels.settings], (_, s) => s.settings()),
    [Channels.setSecret]: handle(schemas[Channels.setSecret], ({ name, value }, s) =>
      s.setSecret(name, value)
    ),
    [Channels.deleteSecret]: handle(schemas[Channels.deleteSecret], ({ name }, s) =>
      s.deleteSecret(name)
    ),
    [Channels.startRun]: handle(schemas[Channels.startRun], ({ conversationId, text }, s) => ({
      runId: s.startRun(conversationId, text)
    })),
    [Channels.cancelRun]: handle(schemas[Channels.cancelRun], ({ runId }, s) => s.cancelRun(runId)),
    [Channels.respond]: handle(schemas[Channels.respond], ({ runId, toolCallId, decision }, s) =>
      s.respondConfirmation(runId, toolCallId, decision)
    ),
    [Channels.revokeAlways]: handle(schemas[Channels.revokeAlways], ({ toolName }, s) =>
      s.revokeAlways(toolName)
    )
  }
}

function fail(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}
