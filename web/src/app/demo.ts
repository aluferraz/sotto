import { DEFAULTS, type Settings } from '../core/settings'
import type { HistoryEntry } from './persist'

/** Made-up content for screenshots, so no real dictation ever ends up in one. */
export function demoSettings(): Settings {
  return {
    ...DEFAULTS,
    hotkeys: ['ctrlRight', 'f13'],
    vocabulary: ['Sotto', 'LiteRT', 'WebGPU', 'Kubernetes', 'Aoife'],
    replacements: [{ heard: 'soto', written: 'Sotto' }, { heard: 'git hub', written: 'GitHub' }],
    snippets: [
      { trigger: 'my calendar link', expansion: 'https://cal.example.com/me' },
      { trigger: 'sign off', expansion: 'Thanks,\nSam' },
    ],
  }
}

export function demoHistory(): HistoryEntry[] {
  const now = Date.now()
  const minute = 60_000
  return [
    { text: 'Okay, for the release we need:\n1. Update the change log.\n2. Bump the version number.\n3. Tag the release on GitHub.', raw: '', at: now - 3 * minute, audioSeconds: 11, ms: 1500 },
    { text: 'So I was thinking we could meet at 6pm at the coffee shop on Main Street, the one next to the library.', raw: '', at: now - 21 * minute, audioSeconds: 12, ms: 1700 },
    { text: 'Hey Marcus, thanks for sending over the quarterly report. I had a look this morning and the numbers look solid.', raw: '', at: now - 64 * minute, audioSeconds: 9, ms: 1300 },
    { text: 'Reminder: water the plants before the weekend, and buy more coffee.', raw: '', at: now - 190 * minute, audioSeconds: 5, ms: 900 },
  ]
}
