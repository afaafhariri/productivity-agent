import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AgentApi, Decision } from '../../../shared/ipc-contract'
import {
  activeRunId,
  canSend,
  initialTranscript,
  isAwaiting,
  isBusy,
  transcriptReducer,
  type Action,
  type Transcript
} from './transcript'

export interface Chat {
  transcript: Transcript
  send(text: string): boolean
  stop(): void
  /** Starts a fresh conversation; does nothing while a run is working. */
  reset(): void
  /** Only an explicit click on an approval card calls this; nothing approves automatically. */
  answer(toolCallId: string, decision: Decision): void
}

export function useChat(agent: AgentApi): Chat {
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript)
  // A new ID for each new chat; the old history stays in the service's memory.
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID())
  const latestRef = useRef(transcript)
  useEffect(() => {
    latestRef.current = transcript
  }, [transcript])

  /** Dispatch, and update `latestRef` at once so a quick second click sees the new state. */
  const apply = useCallback((action: Action): void => {
    latestRef.current = transcriptReducer(latestRef.current, action)
    dispatch(action)
  }, [])

  useEffect(() => agent.onRunEvent((params) => apply({ type: 'event', params })), [agent, apply])

  const send = useCallback(
    (text: string): boolean => {
      if (!canSend(latestRef.current, text)) return false
      apply({ type: 'begin', text, id: crypto.randomUUID() })
      void agent
        .startRun(conversationId, text.trim())
        .then((result) =>
          apply(
            result.ok
              ? { type: 'started', runId: result.value.runId }
              : { type: 'failed_to_start', message: result.error.message }
          )
        )
      return true
    },
    [agent, apply, conversationId]
  )

  const stop = useCallback((): void => {
    const runId = activeRunId(latestRef.current)
    if (runId) void agent.cancelRun(runId)
  }, [agent])

  const reset = useCallback((): void => {
    if (isBusy(latestRef.current)) return
    apply({ type: 'reset' })
    setConversationId(crypto.randomUUID())
  }, [apply])

  const answer = useCallback(
    (toolCallId: string, decision: Decision): void => {
      const runId = activeRunId(latestRef.current)
      if (!runId || !isAwaiting(latestRef.current, toolCallId)) return
      apply({
        type: 'answered',
        toolCallId,
        approved: decision.approved,
        scope: decision.approved ? decision.scope : undefined
      })
      const sent: Decision = decision.approved
        ? decision
        : { approved: false, reason: 'The user rejected this action in the app.' }
      void agent.respond(runId, toolCallId, sent).then((result) => {
        if (!result.ok)
          apply({
            type: 'answer_failed',
            message: `Could not send your answer: ${result.error.message}`
          })
      })
    },
    [agent, apply]
  )

  return { transcript, send, stop, answer, reset }
}
