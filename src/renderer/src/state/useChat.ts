import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { AgentApi } from '../../../shared/ipc-contract'
import {
  activeRunId,
  canSend,
  initialTranscript,
  isAwaiting,
  transcriptReducer,
  type Action,
  type Transcript
} from './transcript'

export interface Chat {
  transcript: Transcript
  send(text: string): boolean
  stop(): void
  /** Only an explicit click on an approval card calls this; nothing approves automatically. */
  answer(toolCallId: string, approved: boolean): void
}

export function useChat(agent: AgentApi): Chat {
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript)
  const conversationId = useRef(crypto.randomUUID())
  const latest = useRef(transcript)
  useEffect(() => {
    latest.current = transcript
  }, [transcript])

  /** Dispatch, and update `latest` at once so a quick second click sees the new state. */
  const apply = useCallback((action: Action): void => {
    latest.current = transcriptReducer(latest.current, action)
    dispatch(action)
  }, [])

  useEffect(() => agent.onRunEvent((params) => apply({ type: 'event', params })), [agent, apply])

  const send = useCallback(
    (text: string): boolean => {
      if (!canSend(latest.current, text)) return false
      apply({ type: 'begin', text, id: crypto.randomUUID() })
      void agent
        .startRun(conversationId.current, text.trim())
        .then((result) =>
          apply(
            result.ok
              ? { type: 'started', runId: result.value.runId }
              : { type: 'failed_to_start', message: result.error.message }
          )
        )
      return true
    },
    [agent, apply]
  )

  const stop = useCallback((): void => {
    const runId = activeRunId(latest.current)
    if (runId) void agent.cancelRun(runId)
  }, [agent])

  const answer = useCallback(
    (toolCallId: string, approved: boolean): void => {
      const runId = activeRunId(latest.current)
      if (!runId || !isAwaiting(latest.current, toolCallId)) return
      apply({ type: 'answered', toolCallId, approved })
      const reason = approved ? undefined : 'The user rejected this action in the app.'
      void agent.respond(runId, toolCallId, approved, reason).then((result) => {
        if (!result.ok)
          apply({
            type: 'answer_failed',
            message: `Could not send your answer: ${result.error.message}`
          })
      })
    },
    [agent, apply]
  )

  return { transcript, send, stop, answer }
}
