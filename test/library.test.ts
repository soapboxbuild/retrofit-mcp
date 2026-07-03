import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/hindsight.js', () => ({
  hindsightRetain: vi.fn(async () => {}),
  hindsightRecall: vi.fn(async () => ({ results: [] })),
}))

import { hindsightRetain, hindsightRecall } from '../src/hindsight.js'

const validInput = () => ({
  admin_key: 'correct-horse-battery-staple-secret',
  title: 'ASHRAE 90.1 Envelope Guide',
  source_org: 'ashrae',
  year: 2022,
  content: 'Some reference content.',
  topics: ['envelope', 'code'],
})

describe('addReference', () => {
  const originalKey = process.env.RETROFIT_LIBRARY_ADMIN_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RETROFIT_LIBRARY_ADMIN_KEY = 'correct-horse-battery-staple-secret'
  })

  afterEach(() => {
    process.env.RETROFIT_LIBRARY_ADMIN_KEY = originalKey
  })

  it('rejects when env admin key is unset, without calling hindsight', async () => {
    delete process.env.RETROFIT_LIBRARY_ADMIN_KEY
    const { addReference } = await import('../src/library.js')
    const result = await addReference(validInput())
    expect(result).toEqual({ added: false, error: 'library admin key not configured' })
    expect(hindsightRetain).not.toHaveBeenCalled()
  })

  it('rejects when env admin key is too short (<32 chars), without calling hindsight', async () => {
    process.env.RETROFIT_LIBRARY_ADMIN_KEY = 'too-short'
    const { addReference } = await import('../src/library.js')
    const result = await addReference(validInput())
    expect(result).toEqual({ added: false, error: 'library admin key not configured' })
    expect(hindsightRetain).not.toHaveBeenCalled()
  })

  it('rejects a wrong admin_key, without calling hindsight', async () => {
    const { addReference } = await import('../src/library.js')
    const result = await addReference({ ...validInput(), admin_key: 'wrong-key-wrong-key-wrong-key-000' })
    expect(result).toEqual({ added: false, error: 'unauthorized' })
    expect(hindsightRetain).not.toHaveBeenCalled()
  })

  it('rejects an invalid source_org slug, without calling hindsight', async () => {
    const { addReference } = await import('../src/library.js')
    const result = await addReference({ ...validInput(), source_org: 'Not A Slug!' })
    expect(result.added).toBe(false)
    expect(result.error).toMatch(/source_org/)
    expect(hindsightRetain).not.toHaveBeenCalled()
  })

  it('rejects invalid topic slugs, without calling hindsight', async () => {
    const { addReference } = await import('../src/library.js')
    const result = await addReference({ ...validInput(), topics: ['ok-topic', 'Bad Topic!'] })
    expect(result.added).toBe(false)
    expect(result.error).toMatch(/topics/)
    expect(hindsightRetain).not.toHaveBeenCalled()
  })

  it('rejects a title over 120 chars, without calling hindsight', async () => {
    const { addReference } = await import('../src/library.js')
    const result = await addReference({ ...validInput(), title: 'x'.repeat(121) })
    expect(result.added).toBe(false)
    expect(result.error).toMatch(/title/)
    expect(hindsightRetain).not.toHaveBeenCalled()
  })

  it('accepts a valid add, retains 1 chunk with the exact tag set, and prefixes content', async () => {
    const { addReference } = await import('../src/library.js')
    const result = await addReference(validInput())
    expect(result).toEqual({ added: true, chunks: 1 })
    expect(hindsightRetain).toHaveBeenCalledTimes(1)
    const [bankId, content, tags] = (hindsightRetain as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(bankId).toBe('retrofit-library')
    expect(content).toBe('ASHRAE 90.1 Envelope Guide (ashrae, 2022) — part 1/1: Some reference content.')
    expect(tags).toEqual(['library', 'org:ashrae', 'topic:envelope', 'topic:code', 'title:ashrae-90-1-envelope-guide', 'year:2022'])
  })

  it('omits the year tag when year is not provided', async () => {
    const { addReference } = await import('../src/library.js')
    const { year, ...withoutYear } = validInput()
    const result = await addReference(withoutYear)
    expect(result.added).toBe(true)
    const [, content, tags] = (hindsightRetain as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content).toBe('ASHRAE 90.1 Envelope Guide (ashrae) — part 1/1: Some reference content.')
    expect(tags).not.toContain(expect.stringMatching(/^year:/))
    expect(tags.some((t: string) => t.startsWith('year:'))).toBe(false)
  })

  it('chunks multi-paragraph content on paragraph boundaries when it exceeds 4000 chars', async () => {
    const { addReference } = await import('../src/library.js')
    const para = 'A'.repeat(3000)
    const content = [para, para, para].join('\n\n') // 3 paragraphs, ~9000+ chars total
    const result = await addReference({ ...validInput(), content })
    expect(result.added).toBe(true)
    expect(result.chunks).toBeGreaterThan(1)
    expect(hindsightRetain).toHaveBeenCalledTimes(result.chunks as number)

    const calls = (hindsightRetain as ReturnType<typeof vi.fn>).mock.calls
    for (const [, chunkContentStr] of calls) {
      // Each retained chunk (including its attribution prefix) must respect the cap.
      const withoutPrefix = chunkContentStr.replace(/^.*?— part \d+\/\d+: /, '')
      expect(withoutPrefix.length).toBeLessThanOrEqual(4000)
    }
    // Same tag set on every chunk
    for (const [, , tags] of calls) {
      expect(tags).toEqual(['library', 'org:ashrae', 'topic:envelope', 'topic:code', 'title:ashrae-90-1-envelope-guide', 'year:2022'])
    }
  })

  it('hard-splits a single paragraph longer than 4000 chars', async () => {
    const { addReference } = await import('../src/library.js')
    const content = 'B'.repeat(9000)
    const result = await addReference({ ...validInput(), content })
    expect(result.added).toBe(true)
    expect(result.chunks).toBe(3)
    expect(hindsightRetain).toHaveBeenCalledTimes(3)
  })
})

describe('searchLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queries the retrofit-library bank and maps results with provenance stamped', async () => {
    ;(hindsightRecall as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        { text: 'chunk one', score: 0.9, tags: ['library', 'org:ashrae'] },
        { text: 'chunk two' },
      ],
    })
    const { searchLibrary } = await import('../src/library.js')
    const results = await searchLibrary('envelope requirements')
    expect(hindsightRecall).toHaveBeenCalledWith('retrofit-library', 'envelope requirements')
    expect(results).toEqual([
      { text: 'chunk one', tags: ['library', 'org:ashrae'], provenance: 'library' },
      { text: 'chunk two', tags: [], provenance: 'library' },
    ])
  })
})
