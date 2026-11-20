import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../../shared/ipc-contract'
import {
  type Action,
  initialTranscript,
  isAwaiting,
  isBusy,
  transcriptReducer,
  type Transcript
} from './transcript'

const play = (actions: Action[], from: Transcript = initialTranscript): Transcript =>
  actions.reduce(transcriptReducer, from)
const ev = (runId: string, event: RunEvent): Action => ({ type: 'event', params: { runId, event } })

describe('transcriptReducer', () => {
  it('ignores empty input and input while busy', () => {
    const t = play([
      { type: 'begin', text: '   ', id: '1' },
      { type: 'begin', text: ' hi ', id: '2' },
      { type: 'begin', text: 'again', id: '3' }
    ])
    expect(t.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', '']
    ])
  })

  it('streams text and finishes', () => {
    const t = play([
      { type: 'begin', text: 'hi', id: '1' },
      { type: 'started', runId: 'r1' },
      ev('r1', { type: 'text_delta', text: 'Hel' }),
      ev('r1', { type: 'text_delta', text: 'lo' }),
      ev('r1', { type: 'done', reason: 'stop' })
    ])
    expect(t.messages[1]).toMatchObject({ text: 'Hello', ended: 'stop' })
    expect(isBusy(t)).toBe(false)
  })

  it('adopts the run when events beat the start response, and ignores other runs', () => {
    const t = play([
      { type: 'begin', text: 'hi', id: '1' },
      ev('r1', { type: 'text_delta', text: 'x' }),
      { type: 'started', runId: 'r1' },
      ev('other', { type: 'text_delta', text: 'y' })
    ])
    expect(t.run).toEqual({ kind: 'running', runId: 'r1' })
    expect(t.messages[1].text).toBe('x')
  })

  it('tracks a tool through approval to its result, answered once', () => {
    let t = play([
      { type: 'begin', text: 'send it', id: '1' },
      { type: 'started', runId: 'r1' },
      ev('r1', {
        type: 'tool_call',
        toolCallId: 'c1',
        toolName: 'email_send',
        input: { to: 'a@b.co' }
      }),
      ev('r1', {
        type: 'confirmation_request',
        toolCallId: 'c1',
        toolName: 'email_send',
        description: 'Sends.',
        input: { to: 'a@b.co' }
      })
    ])
    expect(isAwaiting(t, 'c1')).toBe(true)
    t = play([{ type: 'answered', toolCallId: 'c1', approved: false }], t)
    expect(isAwaiting(t, 'c1')).toBe(false)
    expect(t.messages[1].tools[0].status).toEqual({ kind: 'answered', approved: false })
    t = play(
      [
        ev('r1', {
          type: 'tool_result',
          toolCallId: 'c1',
          toolName: 'email_send',
          result: { status: 'rejected' }
        })
      ],
      t
    )
    expect(t.messages[1].tools[0].status).toEqual({
      kind: 'finished',
      result: { status: 'rejected' }
    })
  })

  it('ends the run on errors and failed starts', () => {
    let t = play([
      { type: 'begin', text: 'a', id: '1' },
      { type: 'started', runId: 'r1' },
      ev('r1', { type: 'error', message: 'boom' })
    ])
    expect(t.messages[1].error).toBe('boom')
    expect(isBusy(t)).toBe(false)
    t = play(
      [
        { type: 'begin', text: 'b', id: '2' },
        { type: 'failed_to_start', message: 'nope' }
      ],
      t
    )
    expect(t.messages[3].error).toBe('nope')
    expect(isBusy(t)).toBe(false)
  })
})
