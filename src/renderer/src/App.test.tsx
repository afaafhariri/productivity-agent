// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityEntry, RunEvent } from '../../shared/ipc-contract'
import App from './App'
import { FakeAgent } from './test/fakeAgent'

/** The chat column only (the agent panel repeats some words, like "Rejected"). */
const chatArea = (): ReturnType<typeof within> => within(screen.getByRole('main'))

async function sendMessage(agent: FakeAgent, text: string): Promise<void> {
  const box = screen.getByLabelText('Message')
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(agent.calls.some(([name]) => name === 'startRun')).toBe(true))
  // Let the startRun response land so the run is adopted.
  await act(async () => {})
}

const draft = { to: 'sam@example.com', subject: 'Hi', body: 'Hello' }

afterEach(cleanup)

describe('chat screen', () => {
  it('sends on Enter and streams the reply as text', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, '  hello  ')

    expect(agent.calls[0]?.[2]).toBe('hello')
    expect(chatArea().getByText('hello')).toBeTruthy()
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('')

    agent.emit({ type: 'text_delta', text: 'Hi ' })
    agent.emit({ type: 'text_delta', text: '**there**' })
    agent.emit({ type: 'done', reason: 'stop' })

    expect(chatArea().getByText('there').tagName).toBe('STRONG')
    expect(screen.getByLabelText('Send')).toBeTruthy()
  })

  it('Shift+Enter does not send', () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'line one' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(agent.calls).toEqual([])
  })

  it('Stop cancels the running run', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'long task')

    fireEvent.click(screen.getByLabelText('Stop'))
    expect(agent.calls.at(-1)).toEqual(['cancelRun', 'run-1'])

    agent.emit({ type: 'done', reason: 'cancelled' })
    expect(chatArea().getByText('Stopped.')).toBeTruthy()
  })

  it('shows tool calls and their results as cards', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'my PRs')

    agent.emit({
      type: 'tool_call',
      toolCallId: 't1',
      toolName: 'github_list_pull_requests',
      input: {}
    })
    expect(chatArea().getByText('Running')).toBeTruthy()
    agent.emit({
      type: 'tool_result',
      toolCallId: 't1',
      toolName: 'github_list_pull_requests',
      result: { total: 2 }
    })
    expect(chatArea().getByText('Done')).toBeTruthy()
    expect(chatArea().getByText(/"total": 2/)).toBeTruthy()
  })

  it('approval card shows exact arguments and sends one answer', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'send it')

    agent.emit({ type: 'tool_call', toolCallId: 't1', toolName: 'gmail_send_draft', input: draft })
    agent.emit({
      type: 'confirmation_request',
      scopes: ['once', 'task', 'always'],
      untrustedSources: [],
      toolCallId: 't1',
      toolName: 'gmail_send_draft',
      description: 'Send an email',
      input: draft
    })

    const card = screen.getByRole('group', { name: 'Approve gmail_send_draft?' })
    expect(card.textContent).toContain('"to": "sam@example.com"')
    const approve = screen.getByRole('button', { name: 'Approve once' })
    expect(document.activeElement).not.toBe(approve)

    fireEvent.click(approve)
    expect(agent.calls.at(-1)).toEqual([
      'respond',
      'run-1',
      't1',
      { approved: true, scope: 'once' }
    ])
    // Answered once: the card is gone, so a second click is impossible.
    expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull()
    expect(chatArea().getByText('Approved, running')).toBeTruthy()
  })

  it('Reject sends a rejection with a reason', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'send it')
    agent.emit({
      type: 'confirmation_request',
      scopes: ['once', 'task', 'always'],
      untrustedSources: [],
      toolCallId: 't1',
      toolName: 'gmail_send_draft',
      description: 'Send an email',
      input: draft
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const last = agent.calls.at(-1)
    expect(last?.slice(0, 3)).toEqual(['respond', 'run-1', 't1'])
    expect(last?.[3]).toMatchObject({ approved: false, reason: expect.any(String) })
    expect(chatArea().getByText('Rejected')).toBeTruthy()

    agent.emit({
      type: 'tool_result',
      toolCallId: 't1',
      toolName: 'gmail_send_draft',
      result: { status: 'rejected', reason: 'no' }
    })
    expect(chatArea().getByText('Rejected')).toBeTruthy()
  })

  it('shows run errors in the reply', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'hi')
    agent.emit({ type: 'error', message: 'Add your Gemini API key in Settings to start chatting.' })
    expect(
      chatArea().getByText('Add your Gemini API key in Settings to start chatting.')
    ).toBeTruthy()
  })

  it('suggestion chips send their text', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    fireEvent.click(screen.getByRole('button', { name: 'What PRs need my review?' }))
    await waitFor(() => expect(agent.calls[0]?.[2]).toBe('What PRs need my review?'))
  })

  it('a config error shows a banner and disables the composer', async () => {
    const agent = new FakeAgent('LLM_MODEL_ID is required')
    render(<App agent={agent} />)
    expect((await screen.findByRole('alert')).textContent).toContain('LLM_MODEL_ID is required')
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true)
  })
})

describe('agent panel', () => {
  it('shows live status and the session log', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    const panel = within(screen.getByRole('complementary', { name: 'Agent' }))
    expect(panel.getByRole('status', { name: 'Agent status' }).textContent).toBe('Ready')

    await sendMessage(agent, 'send it')
    agent.emit({
      type: 'confirmation_request',
      scopes: ['once', 'task', 'always'],
      untrustedSources: [],
      toolCallId: 't1',
      toolName: 'gmail_send_draft',
      description: 'Send an email',
      input: draft
    })
    expect(panel.getByRole('status', { name: 'Agent status' }).textContent).toContain(
      'Waiting for your approval'
    )
    expect(panel.getByText('mock (offline demo)')).toBeTruthy()
  })
})

describe('activity log', () => {
  const entry = (id: string, at: Date, label: string, detail?: string): ActivityEntry => ({
    id,
    at: at.toISOString(),
    tone: 'neutral',
    label,
    ...(detail ? { detail } : {})
  })

  it('shows the saved log grouped by day and adds new entries live', async () => {
    const agent = new FakeAgent()
    const now = new Date()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 15, 30)
    agent.activityLog = [
      entry('a', yesterday, 'You asked', 'What PRs need my review?'),
      entry('b', new Date(yesterday.getTime() + 60_000), 'Used a tool', 'github_list_pull_requests')
    ]
    render(<App agent={agent} />)
    const panel = within(screen.getByRole('complementary', { name: 'Agent' }))
    const earlier = within(await panel.findByRole('region', { name: 'Yesterday' }))
    expect(earlier.getByText('github_list_pull_requests')).toBeTruthy()
    expect(panel.queryByRole('region', { name: 'Today' })).toBeNull()

    agent.record(entry('c', now, 'Approved once', 'gmail_send_draft'))
    const today = within(panel.getByRole('region', { name: 'Today' }))
    expect(today.getByText('Approved once')).toBeTruthy()
    // Newest day first, and each entry only once even if it also comes back from a reload.
    expect(panel.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Today', 'Yesterday'])
    expect(panel.getAllByText('Approved once')).toHaveLength(1)
  })

  it('works under StrictMode, which runs effects and updates twice', async () => {
    const agent = new FakeAgent()
    agent.activityLog = [entry('a', new Date(), 'Replied')]
    render(
      <StrictMode>
        <App agent={agent} />
      </StrictMode>
    )
    const panel = within(screen.getByRole('complementary', { name: 'Agent' }))
    expect(await panel.findByText('Replied')).toBeTruthy()
    agent.record(entry('b', new Date(), 'Stopped'))
    expect(panel.getByText('Stopped')).toBeTruthy()
    expect(panel.getAllByText('Replied')).toHaveLength(1)
  })

  it('says when there is nothing yet', async () => {
    render(<App agent={new FakeAgent()} />)
    const panel = within(screen.getByRole('complementary', { name: 'Agent' }))
    expect(await panel.findByText('Nothing yet.')).toBeTruthy()
  })
})

describe('approval scopes', () => {
  const ask = (
    scopes: Array<'once' | 'task' | 'always'>,
    untrustedSources: string[] = []
  ): RunEvent => ({
    type: 'confirmation_request',
    scopes,
    untrustedSources,
    toolCallId: 't1',
    toolName: 'gmail_send_draft',
    description: 'Send an email',
    input: draft
  })

  it('offers every scope on a clean task and sends the chosen one', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'send it')
    agent.emit(ask(['once', 'task', 'always']))
    for (const name of ['Approve once', 'Allow for this task', 'Always allow']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(agent.calls.at(-1)).toEqual([
      'respond',
      'run-1',
      't1',
      { approved: true, scope: 'always' }
    ])
  })

  it('after an untrusted read, explains why and offers only "once"', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'reply to that email')
    agent.emit(ask(['once'], ['gmail_list_unread']))
    const card = screen.getByRole('group', { name: 'Approve gmail_send_draft?' })
    expect(card.textContent).toContain('outside sources (gmail_list_unread)')
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow for this task' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull()
  })

  it('marks a write that ran without asking', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'send it')
    agent.emit({ type: 'tool_call', toolCallId: 't1', toolName: 'gmail_send_draft', input: draft })
    agent.emit({
      type: 'auto_approved',
      toolCallId: 't1',
      toolName: 'gmail_send_draft',
      scope: 'always'
    })
    expect(chatArea().getByText('Always allowed')).toBeTruthy()
  })
})

describe('hidden secrets', () => {
  it('says what was hidden from the model, and where', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'my token is ghp_x')
    agent.emit({ type: 'redacted', source: 'message', hidden: ['GitHub token'] })
    agent.emit({
      type: 'redacted',
      source: 'tool',
      toolName: 'github_list_issues',
      hidden: ['AWS access key']
    })
    const chat = chatArea()
    expect(chat.getByText(/Hidden from the model: GitHub token in your message/)).toBeTruthy()
    expect(chat.getByText(/Hidden from the model: AWS access key/).textContent).toContain(
      "github_list_issues's result"
    )
  })
})

describe('token usage', () => {
  it('shows tokens used today in the panel and explains a stop at the limit', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    const panel = within(screen.getByRole('complementary', { name: 'Agent' }))
    expect(await panel.findByText('1.2K / 1M')).toBeTruthy()

    await sendMessage(agent, 'big task')
    agent.usage = { tokensToday: 1_000_000, limit: 1_000_000 }
    agent.emit({ type: 'usage', tokensToday: 1_000_000, limit: 1_000_000 })
    expect(await panel.findByText('1M / 1M')).toBeTruthy()
    agent.emit({ type: 'done', reason: 'token_limit' })
    expect(chatArea().getByText(/Stopped at today's token limit/)).toBeTruthy()
  })
})

describe('new chat and shortcuts', () => {
  const startRuns = (agent: FakeAgent): unknown[][] =>
    agent.calls.filter(([name]) => name === 'startRun')

  it('New chat clears the chat and starts a new conversation', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'first')

    const newChat = screen.getByLabelText('New chat') as HTMLButtonElement
    expect(newChat.disabled).toBe(true)
    agent.emit({ type: 'done', reason: 'stop' })
    expect(newChat.disabled).toBe(false)

    fireEvent.click(newChat)
    expect(chatArea().queryByText('first')).toBeNull()

    await sendMessage(agent, 'second')
    await waitFor(() => expect(startRuns(agent)).toHaveLength(2))
    const [a, b] = startRuns(agent)
    expect(b?.[1]).not.toBe(a?.[1])
  })

  it('Esc stops a run, Cmd+N starts a new chat and Ctrl+, opens Settings', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'long task')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(agent.calls.at(-1)).toEqual(['cancelRun', 'run-1'])
    agent.emit({ type: 'done', reason: 'cancelled' })

    fireEvent.keyDown(window, { key: 'n', metaKey: true })
    expect(chatArea().queryByText('long task')).toBeNull()

    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()
  })
})
