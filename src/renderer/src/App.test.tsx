// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
      toolCallId: 't1',
      toolName: 'gmail_send_draft',
      description: 'Send an email',
      input: draft
    })

    const card = screen.getByRole('group', { name: 'Approve gmail_send_draft?' })
    expect(card.textContent).toContain('"to": "sam@example.com"')
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(document.activeElement).not.toBe(approve)

    fireEvent.click(approve)
    expect(agent.calls.at(-1)).toEqual(['respond', 'run-1', 't1', true, undefined])
    // Answered once: the card is gone, so a second click is impossible.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(chatArea().getByText('Approved, running')).toBeTruthy()
  })

  it('Reject sends a rejection with a reason', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await sendMessage(agent, 'send it')
    agent.emit({
      type: 'confirmation_request',
      toolCallId: 't1',
      toolName: 'gmail_send_draft',
      description: 'Send an email',
      input: draft
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const last = agent.calls.at(-1)
    expect(last?.slice(0, 4)).toEqual(['respond', 'run-1', 't1', false])
    expect(typeof last?.[4]).toBe('string')
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
    expect(panel.getByText('Nothing yet.')).toBeTruthy()

    await sendMessage(agent, 'send it')
    agent.emit({
      type: 'confirmation_request',
      toolCallId: 't1',
      toolName: 'gmail_send_draft',
      description: 'Send an email',
      input: draft
    })
    expect(panel.getByRole('status', { name: 'Agent status' }).textContent).toContain(
      'Waiting for your approval'
    )
    expect(panel.getByText('You asked')).toBeTruthy()
    expect(panel.getByText('mock (offline demo)')).toBeTruthy()
  })
})
