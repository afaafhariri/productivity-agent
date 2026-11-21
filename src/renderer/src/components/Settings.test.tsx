// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../App'
import { FakeAgent } from '../test/fakeAgent'

afterEach(cleanup)

async function openSettings(agent: FakeAgent): Promise<void> {
  render(<App agent={agent} />)
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  await screen.findByRole('heading', { name: 'Settings' })
}

const keyField = (): HTMLInputElement => screen.getByLabelText('Gemini API key') as HTMLInputElement

describe('settings', () => {
  it('shows the model and tools with their effect', async () => {
    const agent = new FakeAgent()
    await openSettings(agent)
    const tools = within(await screen.findByRole('region', { name: 'Tools' }))
    expect(tools.getByText('github_list_pull_requests')).toBeTruthy()
    expect(tools.getByText('Read-only')).toBeTruthy()
    expect(tools.getByText('Asks first')).toBeTruthy()
    expect(tools.getByText('api.github.com')).toBeTruthy()
    expect(tools.getByText('No network access')).toBeTruthy()
    const model = within(screen.getByRole('region', { name: 'Model' }))
    expect(model.getByText('mock')).toBeTruthy()
    expect(model.getByText('offline demo')).toBeTruthy()
  })

  it('saves a key write-only and clears the field', async () => {
    const agent = new FakeAgent()
    await openSettings(agent)
    expect(keyField().type).toBe('password')

    fireEvent.change(keyField(), { target: { value: 'AIza-test-key' } })
    fireEvent.click(within(keyField().closest('form')!).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(agent.calls).toContainEqual(['setSecret', 'gemini_api_key', 'AIza-test-key'])
    expect(keyField().value).toBe('')
    // The page never contains the value, only whether it is set.
    expect(document.body.textContent).not.toContain('AIza-test-key')
    expect(screen.getAllByText('Saved').length).toBe(1)
    expect(
      within(keyField().closest('form')!).getByRole('button', { name: 'Replace' })
    ).toBeTruthy()
  })

  it('shows why a key was refused and keeps the field', async () => {
    const agent = new FakeAgent()
    agent.rejectSecret = 'That doesn’t look like a Gemini API key.'
    await openSettings(agent)

    fireEvent.change(keyField(), { target: { value: 'bad key' } })
    fireEvent.submit(keyField().closest('form')!)

    expect(await screen.findByText('That doesn’t look like a Gemini API key.')).toBeTruthy()
    expect(keyField().value).toBe('bad key')
  })

  it('has a write-only field for the Claude key', async () => {
    const agent = new FakeAgent()
    await openSettings(agent)
    const field = screen.getByLabelText('Claude API key') as HTMLInputElement
    expect(field.type).toBe('password')

    fireEvent.change(field, { target: { value: 'sk-ant-test' } })
    fireEvent.click(within(field.closest('form')!).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(agent.calls).toContainEqual(['setSecret', 'anthropic_api_key', 'sk-ant-test'])
    expect(field.value).toBe('')
    expect(document.body.textContent).not.toContain('sk-ant-test')
  })

  it('shows an "Always allow" chosen after the app started', async () => {
    const agent = new FakeAgent()
    render(<App agent={agent} />)
    await screen.findByRole('textbox', { name: 'Message' })
    agent.always.add('gmail_send_draft') // e.g. chosen on an approval card during a run
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const tools = within(await screen.findByRole('region', { name: 'Tools' }))
    expect(await tools.findByText('Always allowed')).toBeTruthy()
  })

  it('lets you revoke an always-allowed tool', async () => {
    const agent = new FakeAgent()
    agent.always.add('gmail_send_draft')
    await openSettings(agent)
    const tools = within(await screen.findByRole('region', { name: 'Tools' }))
    expect(tools.getByText('Always allowed')).toBeTruthy()

    fireEvent.click(tools.getByRole('button', { name: 'Revoke always allow for gmail_send_draft' }))
    expect(await tools.findByText('Asks first')).toBeTruthy()
    expect(agent.calls.at(-1)).toEqual(['revokeAlways', 'gmail_send_draft'])
  })

  it('removes a saved key', async () => {
    const agent = new FakeAgent()
    await agent.setSecret('github_token', 'ghp_x')
    await openSettings(agent)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('Removed.')).toBeTruthy()
    expect(agent.calls.at(-1)).toEqual(['deleteSecret', 'github_token'])
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('shows the configuration error instead of settings', async () => {
    const agent = new FakeAgent('LLM_MODEL_ID is required')
    await openSettings(agent)
    expect(await screen.findByText('LLM_MODEL_ID is required')).toBeTruthy()
  })
})

describe('daily token limit', () => {
  it("shows today's usage and changes or removes the limit", async () => {
    const agent = new FakeAgent()
    await openSettings(agent)
    const section = within(await screen.findByRole('region', { name: 'Daily token limit' }))
    expect(section.getByText('1,234')).toBeTruthy()
    expect(section.getByText('1,000,000')).toBeTruthy()

    const input = section.getByLabelText('Daily token limit')
    fireEvent.change(input, { target: { value: '500' } })
    fireEvent.submit(input.closest('form')!)
    expect(await section.findByText('The daily limit must be at least 10,000 tokens')).toBeTruthy()

    fireEvent.change(input, { target: { value: '250,000' } })
    fireEvent.submit(input.closest('form')!)
    expect(await section.findByText('Saved.')).toBeTruthy()
    expect(agent.calls).toContainEqual(['setTokenLimit', 250_000])
    expect(await section.findByText('250,000')).toBeTruthy()

    fireEvent.click(section.getByRole('button', { name: 'No limit' }))
    expect(await section.findByText('Limit turned off.')).toBeTruthy()
    expect(section.getByText(/no limit/)).toBeTruthy()
  })
})
