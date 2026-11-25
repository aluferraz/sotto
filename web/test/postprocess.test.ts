import { describe, expect, it } from 'vitest'
import { fit, process, type CleanupLevel, type Replacement, type Snippet, type Tone } from '../src/core/postprocess'

const run = (s: string, o: { cleanup?: CleanupLevel; tone?: Tone; replacements?: Replacement[]; snippets?: Snippet[] } = {}) =>
  process(s, { cleanup: o.cleanup ?? 'light', tone: o.tone ?? 'formal', replacements: o.replacements, snippets: o.snippets })

describe('post-processing', () => {
  it('removes fillers and recapitalizes the sentence', () => {
    expect(run('Um, so I was thinking we could, uh, meet at 5.')).toBe('So I was thinking we could, meet at 5.')
    expect(run('Second, uhm, bump the version.')).toBe('Second, bump the version.')
    expect(run('It is done. Uh, next we ship.')).toBe('It is done. Next we ship.')
  })

  it('keeps words that contain filler letters', () => {
    expect(run('The umbrella and the hummus are in the drum.')).toBe('The umbrella and the hummus are in the drum.')
    expect(run('Uhura hummed.')).toBe('Uhura hummed.')
  })

  it('collapses stutters but keeps deliberate doubles', () => {
    expect(run('I I think the the cache is stale')).toBe('I think the cache is stale')
    expect(run('He said that that was fine, bye bye')).toBe('He said that that was fine, bye bye')
  })

  it('leaves everything in verbatim mode', () => {
    expect(run('Um, the the thing.', { cleanup: 'verbatim' })).toBe('Um, the the thing.')
  })

  it('does not treat numbers as stutters', () => {
    expect(run('Call 5 5 5 0 1 2 3')).toBe('Call 5 5 5 0 1 2 3')
    expect(run('Version 3.5 is out. e.g. this')).toBe('Version 3.5 is out. e.g. this')
  })

  it('matches replacements as whole words, ignoring case', () => {
    const replacements = [{ heard: 'soto', written: 'Sotto' }, { heard: 'git hub', written: 'GitHub' }]
    expect(run('Push soto to Git  Hub, not sotoro.', { replacements })).toBe('Push Sotto to GitHub, not sotoro.')
  })

  it('inserts replacement text literally', () => {
    expect(run('The price', { replacements: [{ heard: 'price', written: '$5 \\ each $& $1' }] })).toBe('The $5 \\ each $& $1')
  })

  it('expands a snippet said on its own to exactly its text', () => {
    const snippets = [{ trigger: 'my address', expansion: '1 Infinite Loop\nCupertino, CA' }]
    expect(run('My address.', { snippets })).toBe('1 Infinite Loop\nCupertino, CA')
  })

  it('expands a snippet inside a sentence and skips the tone', () => {
    const snippets = [{ trigger: 'calendar link', expansion: 'https://cal.example/me' }]
    expect(run('Book a slot at calendar link.', { tone: 'veryCasual', snippets })).toBe('Book a slot at https://cal.example/me.')
  })

  it('applies tones', () => {
    const s = "Hey, are you free tomorrow? I'm around. API access works. Let's do 12."
    expect(run(s, { tone: 'formal' })).toBe(s)
    expect(run(s, { tone: 'casual' })).toBe("Hey, are you free tomorrow? I'm around. API access works. Let's do 12")
    expect(run(s, { tone: 'veryCasual' })).toBe("hey, are you free tomorrow? I'm around. API access works. let's do 12")
  })

  it('leaves lists and ellipses alone', () => {
    expect(run('Three things:\n1. Ship.\n2. Rest.', { tone: 'veryCasual' })).toBe('Three things:\n1. Ship.\n2. Rest.')
    expect(run('Well...', { tone: 'casual' })).toBe('Well...')
  })

  it('fits text to what is before the cursor', () => {
    expect(fit('And then we left.', 'We ate')).toBe(' and then we left.')
    expect(fit('Next sentence.', 'Done.')).toBe(' Next sentence.')
    expect(fit('Next sentence.', 'Done. ')).toBe('Next sentence.')
    expect(fit('Hello.', '')).toBe('Hello.')
    expect(fit('Hello.', null)).toBe('Hello.')
    expect(fit('Hello', 'say (')).toBe('Hello')
  })

  it('keeps capitals that matter when fitting', () => {
    expect(fit('I think so.', 'well,')).toBe(' I think so.')
    expect(fit('API keys rotate.', 'the')).toBe(' API keys rotate.')
    expect(fit('Sotto works.', 'and', ['Sotto'])).toBe(' Sotto works.')
    expect(fit('New line', 'first line\n')).toBe('New line')
  })

  it('returns nothing for empty or filler-only input', () => {
    expect(run('   ')).toBe('')
    expect(run('Um, uh.')).toBe('')
  })
})
