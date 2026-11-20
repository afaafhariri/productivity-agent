/**
 * Hides secrets from the model. Saved keys and tokens, and anything shaped like a common
 * credential, are replaced with a label such as `[hidden: GitHub token]` before user messages
 * and tool results reach the model or the conversation history.
 */
import type { JsonValue } from '../json'
import type { SecretStore } from '../ports'

export interface KnownSecret {
  /** Shown to the user, e.g. "GitHub token". Never the value. */
  label: string
  key: string
}

/** Credential shapes worth hiding even when they aren't saved in the app. */
const PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: 'private key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  {
    label: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g
  },
  { label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g }
]

/** Saved values shorter than this aren't matched, so a tiny test value can't eat normal text. */
const MIN_KNOWN_LENGTH = 8

export class Redactor {
  private constructor(private readonly known: ReadonlyArray<{ label: string; value: string }>) {}

  /** Reads the saved secrets once; build a new one per run so changed keys are picked up. */
  static async fromStore(secrets: SecretStore, known: KnownSecret[]): Promise<Redactor> {
    const values: Array<{ label: string; value: string }> = []
    for (const { label, key } of known) {
      const value = await secrets.get(key)
      if (value && value.length >= MIN_KNOWN_LENGTH) values.push({ label, value })
    }
    // Longest first, so a value that contains another is replaced whole.
    values.sort((a, b) => b.value.length - a.value.length)
    return new Redactor(values)
  }

  /** Only pattern matching; for tests and hosts without a secret store. */
  static patternsOnly(): Redactor {
    return new Redactor([])
  }

  /** Returns the text with secrets replaced, and the labels of what was hidden. */
  text(input: string): { text: string; hidden: string[] } {
    const hidden = new Set<string>()
    let text = input
    for (const { label, value } of this.known) {
      if (text.includes(value)) {
        text = text.split(value).join(`[hidden: ${label}]`)
        hidden.add(label)
      }
    }
    for (const { label, pattern } of PATTERNS) {
      text = text.replace(pattern, () => {
        hidden.add(label)
        return `[hidden: ${label}]`
      })
    }
    return { text, hidden: [...hidden] }
  }

  /** The same for every string (keys included) in a JSON value. */
  json(input: JsonValue): { value: JsonValue; hidden: string[] } {
    const hidden = new Set<string>()
    const walk = (value: JsonValue): JsonValue => {
      if (typeof value === 'string') {
        const result = this.text(value)
        result.hidden.forEach((label) => hidden.add(label))
        return result.text
      }
      if (Array.isArray(value)) return value.map(walk)
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [walk(key) as string, walk(item)])
        )
      }
      return value
    }
    return { value: walk(input), hidden: [...hidden] }
  }
}
