import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../../shared/ipc-contract'
import { activityLog, agentStatus } from './activity'
import { initialTranscript, transcriptReducer, type Action, type Transcript } from './transcript'

const play = (...actions: Action[]): Transcript =>
  actions.reduce(transcriptReducer, initialTranscript)
const ev = (event: RunEvent): Action => ({ type: 'event', params: { runId: 'r', event } })
const draft = { to: 'a@b.co', subject: 's', body: 'b' }

const begin: Action = { type: 'begin', text: 'send it', id: 'm1' }
const started: Action = { type: 'started', runId: 'r' }
const call = ev({ type: 'tool_call', toolCallId: 't', toolName: 'gmail_send_draft', input: draft })
const ask = ev({
  type: 'confirmation_request',
  scopes: ['once', 'task', 'always'],
  untrustedSources: [],
  toolCallId: 't',
  toolName: 'gmail_send_draft',
  description: 'Send',
  input: draft
})

describe('agent status', () => {
  it('follows a run from thinking to approval to done', () => {
    expect(agentStatus(initialTranscript)).toEqual({ kind: 'idle' })
    expect(agentStatus(play(begin, started))).toEqual({ kind: 'thinking' })
    expect(agentStatus(play(begin, started, call))).toEqual({
      kind: 'tool',
      name: 'gmail_send_draft'
    })
    expect(agentStatus(play(begin, started, call, ask))).toEqual({
      kind: 'awaiting',
      name: 'gmail_send_draft'
    })
    expect(agentStatus(play(begin, started, ev({ type: 'text_delta', text: 'Hi' })))).toEqual({
      kind: 'replying'
    })
    expect(agentStatus(play(begin, started, ev({ type: 'done', reason: 'stop' })))).toEqual({
      kind: 'idle'
    })
  })
})

describe('activity log', () => {
  it('records the question, the approval and the outcome', () => {
    const t = play(
      begin,
      started,
      call,
      ask,
      { type: 'answered', toolCallId: 't', approved: true },
      ev({
        type: 'tool_result',
        toolCallId: 't',
        toolName: 'gmail_send_draft',
        result: { ok: true }
      }),
      ev({ type: 'done', reason: 'stop' })
    )
    expect(activityLog(t).map((e) => [e.label, e.detail])).toEqual([
      ['You asked', 'send it'],
      ['Approved and ran', 'gmail_send_draft'],
      ['Replied', undefined]
    ])
  })

  it('records rejections, stops and errors', () => {
    const rejected = play(
      begin,
      started,
      ask,
      { type: 'answered', toolCallId: 't', approved: false },
      ev({
        type: 'tool_result',
        toolCallId: 't',
        toolName: 'gmail_send_draft',
        result: { status: 'rejected' }
      }),
      ev({ type: 'done', reason: 'cancelled' })
    )
    expect(activityLog(rejected).map((e) => e.label)).toEqual(['You asked', 'Rejected', 'Stopped'])

    const failed = play(begin, started, ev({ type: 'error', message: 'Gemini is down' }))
    expect(activityLog(failed).at(-1)).toMatchObject({
      tone: 'danger',
      label: 'Failed',
      detail: 'Gemini is down'
    })
  })

  it('clips long questions', () => {
    const t = play({ type: 'begin', text: 'x'.repeat(200), id: 'm' })
    expect(activityLog(t)[0]?.detail?.length).toBe(81)
  })
})
