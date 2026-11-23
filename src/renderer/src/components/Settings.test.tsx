// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelList } from '../../../shared/ipc-contract'
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
    const model = screen.getByRole('region', { name: 'Model' })
    expect(model.textContent).toContain('Using Offline demo (default from .env)')
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

  it('has no Claude key field', async () => {
    await openSettings(new FakeAgent())
    expect(screen.queryByLabelText('Claude API key')).toBeNull()
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

describe('model picker', () => {
  const picker = (): ReturnType<typeof within> =>
    within(screen.getByRole('region', { name: 'Model' }))

  it('switches provider and model without a restart', async () => {
    const agent = new FakeAgent()
    await agent.setSecret('gemini_api_key', 'AIza-test')
    await openSettings(agent)

    fireEvent.change(picker().getByLabelText('Provider'), { target: { value: 'gemini' } })
    // This provider lists no models here, so a text field appears once the list has loaded.
    await picker().findByPlaceholderText(/A current model ID from Google AI Studio/)
    const switchButton = picker().getByRole('button', { name: 'Switch' }) as HTMLButtonElement
    expect(switchButton.disabled).toBe(true) // needs a model ID first
    fireEvent.change(picker().getByLabelText('Model', { selector: 'input, select' }), {
      target: { value: ' gemini-test-model ' }
    })
    fireEvent.click(switchButton)

    expect(
      await picker().findByText(/Switched\. Your next message uses Gemini · gemini-test-model/)
    ).toBeTruthy()
    expect(agent.calls).toContainEqual(['setModel', 'gemini', 'gemini-test-model'])
    expect(screen.getByRole('region', { name: 'Model' }).textContent).toContain(
      'Using Gemini · gemini-test-model (chosen here)'
    )
    // The agent panel follows the switch too.
    const panel = within(screen.getByRole('complementary', { name: 'Agent' }))
    expect(await panel.findByText('gemini · gemini-test-model')).toBeTruthy()
  })

  it("needs the provider's key before switching to it", async () => {
    const agent = new FakeAgent()
    await openSettings(agent)
    const select = picker().getByLabelText('Provider')
    expect(within(select).getByRole('option', { name: 'Gemini (no key yet)' })).toBeTruthy()
    fireEvent.change(select, { target: { value: 'gemini' } })
    fireEvent.change(picker().getByLabelText('Model', { selector: 'input, select' }), {
      target: { value: 'some-model' }
    })
    expect(picker().getByText(/Save your Gemini API key under Keys below first/)).toBeTruthy()
    expect((picker().getByRole('button', { name: 'Switch' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})

describe('model dropdown', () => {
  const picker = (): ReturnType<typeof within> =>
    within(screen.getByRole('region', { name: 'Model' }))
  const modelField = (): HTMLSelectElement | HTMLInputElement =>
    picker().getByLabelText('Model', { selector: 'input, select' }) as HTMLSelectElement

  async function withGemini(list: ModelList): Promise<FakeAgent> {
    const agent = new FakeAgent()
    await agent.setSecret('gemini_api_key', 'AIza-test')
    agent.modelLists.gemini = list
    await openSettings(agent)
    fireEvent.change(picker().getByLabelText('Provider'), { target: { value: 'gemini' } })
    return agent
  }

  it("lists the provider's models by name, newest selected, and switches to the chosen one", async () => {
    const agent = await withGemini({
      status: 'ok',
      models: [
        { id: 'gemini-new', name: 'Gemini New' },
        { id: 'gemini-old', name: 'Gemini Old' }
      ]
    })
    expect(await picker().findByRole('option', { name: 'Gemini New (gemini-new)' })).toBeTruthy()
    expect(modelField().tagName).toBe('SELECT')
    expect(modelField().value).toBe('gemini-new')
    expect(agent.calls).toContainEqual(['listModels', 'gemini'])

    fireEvent.change(modelField(), { target: { value: 'gemini-old' } })
    fireEvent.click(picker().getByRole('button', { name: 'Switch' }))
    expect(await picker().findByText(/Your next message uses Gemini · gemini-old/)).toBeTruthy()
    expect(agent.calls).toContainEqual(['setModel', 'gemini', 'gemini-old'])
  })

  it('lets you type an ID that is not in the list', async () => {
    const agent = await withGemini({
      status: 'ok',
      models: [{ id: 'gemini-new', name: 'Gemini New' }]
    })
    await picker().findByRole('option', { name: 'Gemini New (gemini-new)' })
    fireEvent.change(modelField(), { target: { value: 'type an id' } })
    expect(modelField().tagName).toBe('INPUT')
    fireEvent.change(modelField(), { target: { value: 'gemini-preview' } })
    fireEvent.click(picker().getByRole('button', { name: 'Switch' }))
    await picker().findByText(/Switched/)
    expect(agent.calls).toContainEqual(['setModel', 'gemini', 'gemini-preview'])
    // The saved ID isn't in the list, so the dropdown shows it as such.
    expect(
      await picker().findByRole('option', { name: 'gemini-preview (not in the list)' })
    ).toBeTruthy()
  })

  it('falls back to typing when the list cannot be loaded', async () => {
    await withGemini({ status: 'error', message: "Couldn't reach Gemini to list its models." })
    expect(
      await picker().findByText(
        /Couldn't reach Gemini to list its models\. Type a model ID instead\./
      )
    ).toBeTruthy()
    expect(modelField().tagName).toBe('INPUT')
  })
})
