import { describe, expect, it } from 'vitest'
import { systemPrompt } from './prompt'

describe('systemPrompt', () => {
  it("states today's date in the user's time zone", () => {
    // 20:00 UTC on 22 November is already 23 November in Colombo (UTC+5:30).
    const prompt = systemPrompt(new Date('2026-11-22T20:00:00Z'), 'Asia/Colombo')
    expect(prompt).toContain('Today is Monday, November 23, 2026 (time zone: Asia/Colombo).')
    expect(prompt).toContain('untrusted_content')
  })
})
