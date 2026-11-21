import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../ports'
import { Redactor } from './redact'

const GH = `ghp_${'a1B2'.repeat(9)}`
const ANT = `sk-ant-api03-${'x'.repeat(40)}`

async function redactor(): Promise<Redactor> {
  const secrets = new MemorySecretStore()
  await secrets.set('github_token', 'my-custom-token-value')
  await secrets.set('short', 'abc')
  return Redactor.fromStore(secrets, [
    { label: 'GitHub token', key: 'github_token' },
    { label: 'Short', key: 'short' },
    { label: 'Missing', key: 'missing' }
  ])
}

describe('Redactor', () => {
  it('hides saved secrets wherever they appear, and nothing else', async () => {
    const r = await redactor()
    expect(r.text('use my-custom-token-value twice: my-custom-token-value')).toEqual({
      text: 'use [hidden: GitHub token] twice: [hidden: GitHub token]',
      hidden: ['GitHub token']
    })
    // Values too short to match safely are left alone; ordinary text is untouched.
    expect(r.text('abc is fine, as is a normal sentence about sk-rockets')).toEqual({
      text: 'abc is fine, as is a normal sentence about sk-rockets',
      hidden: []
    })
  })

  it('hides credential-shaped strings that were never saved', () => {
    const r = Redactor.patternsOnly()
    const input = [
      `gh: ${GH}`,
      `claude: ${ANT}`,
      `google: AIza${'b'.repeat(35)}`,
      'aws: AKIAABCDEFGHIJKLMNOP',
      'slack: xoxb-1234567890-abcdef',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----'
    ].join('\n')
    const { text, hidden } = r.text(input)
    expect(text).not.toMatch(/ghp_|sk-ant-|AIza|AKIA|xoxb-|abc\ndef/)
    expect(hidden.sort()).toEqual(
      [
        'AWS access key',
        'Anthropic API key',
        'GitHub token',
        'Google API key',
        'Slack token',
        'private key'
      ].sort()
    )
    // An Anthropic key isn't also reported as an OpenAI key.
    expect(text).toContain('claude: [hidden: Anthropic API key]')
  })

  it('walks JSON values and keys', async () => {
    const r = await redactor()
    const { value, hidden } = r.json({
      items: [{ title: `token ${GH}`, n: 1, ok: true, none: null }],
      [`key-my-custom-token-value`]: 'x'
    })
    expect(value).toEqual({
      items: [{ title: 'token [hidden: GitHub token]', n: 1, ok: true, none: null }],
      'key-[hidden: GitHub token]': 'x'
    })
    expect(hidden).toEqual(['GitHub token'])
  })
})
