import type { CleanupLevel, Replacement, Snippet, Tone } from './postprocess'

/** Language names the model understands, with the codes cloud APIs expect. '' = detect. */
export const LANGUAGES: ReadonlyArray<readonly [name: string, code: string]> = [
  ['English', 'en'], ['Arabic', 'ar'], ['Chinese', 'zh'], ['Danish', 'da'], ['Dutch', 'nl'], ['Finnish', 'fi'],
  ['French', 'fr'], ['German', 'de'], ['Greek', 'el'], ['Hebrew', 'he'], ['Italian', 'it'], ['Japanese', 'ja'],
  ['Korean', 'ko'], ['Polish', 'pl'], ['Portuguese', 'pt'], ['Spanish', 'es'], ['Swedish', 'sv'], ['Turkish', 'tr'],
]

export const languageCode = (name: string) => LANGUAGES.find(([n]) => n === name)?.[1] ?? ''

/**
 * Keys that can start dictation. All of them type nothing on their own. `code` is the browser's
 * name for the key; the Windows app maps the same ids to system-wide key codes.
 */
export const HOTKEYS = [
  { id: 'ctrlRight', label: 'Right Ctrl', code: 'ControlRight' },
  { id: 'altRight', label: 'Right Alt', code: 'AltRight' },
  { id: 'shiftRight', label: 'Right Shift', code: 'ShiftRight' },
  { id: 'f13', label: 'F13', code: 'F13' },
  { id: 'f14', label: 'F14', code: 'F14' },
  { id: 'f15', label: 'F15', code: 'F15' },
  { id: 'f16', label: 'F16', code: 'F16' },
] as const

export type HotkeyId = (typeof HOTKEYS)[number]['id']

export interface EngineSettings {
  /** 'local' runs the model on this computer's GPU; 'cloud' sends the audio to an API. */
  kind: 'local' | 'cloud'
  /** An OpenAI-compatible API root, such as https://api.openai.com/v1. */
  baseUrl: string
  /** The transcription model's name at that API. */
  model: string
  /** A chat model for the Smart editing pass; empty to skip that pass with the API. */
  cleanupModel: string
}

export interface Settings {
  /** An English language name, or '' to let the model detect it. */
  language: string
  cleanup: CleanupLevel
  tone: Tone
  vocabulary: string[]
  replacements: Replacement[]
  snippets: Snippet[]
  keepHistory: boolean
  sounds: boolean
  engine: EngineSettings
  /** Minutes without dictation after which the model leaves memory; 0 keeps it. */
  unloadAfterMinutes: number
  /** Browser page: also put each result on the clipboard. */
  copyAutomatically: boolean
  /** Any of these starts dictation. Never empty. */
  hotkeys: HotkeyId[]
  /** The microphone to record from, as the browser's device id; '' is the system's default. */
  microphoneId: string
  /** That microphone's name, to show while it is unplugged. */
  microphoneLabel: string
  /** Windows app: put the clipboard back after pasting. */
  restoreClipboard: boolean
  /** Windows app: start with Windows. */
  launchAtLogin: boolean
}

export const DEFAULTS: Settings = {
  language: 'English',
  cleanup: 'smart',
  tone: 'formal',
  vocabulary: [],
  replacements: [],
  snippets: [],
  keepHistory: true,
  sounds: true,
  engine: { kind: 'local', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', cleanupModel: '' },
  unloadAfterMinutes: 15,
  copyAutomatically: false,
  hotkeys: ['ctrlRight'],
  microphoneId: '',
  microphoneLabel: '',
  restoreClipboard: true,
  launchAtLogin: false,
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback
const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

export function normalizeHotkeys(keys: unknown): HotkeyId[] {
  const wanted = list(keys)
  const kept = HOTKEYS.map((k) => k.id).filter((id) => wanted.includes(id))
  return kept.length ? kept : [...DEFAULTS.hotkeys]
}

/** Settings from whatever was stored, field by field, so an older or damaged file still loads. */
export function normalize(stored: unknown): Settings {
  const s = record(stored)
  const e = record(s.engine)
  const minutes = Number(s.unloadAfterMinutes)
  return {
    language: LANGUAGES.some(([n]) => n === s.language) || s.language === '' ? (s.language as string) : DEFAULTS.language,
    cleanup: oneOf(s.cleanup, ['verbatim', 'light', 'smart'], DEFAULTS.cleanup),
    tone: oneOf(s.tone, ['formal', 'casual', 'veryCasual'], DEFAULTS.tone),
    vocabulary: list(s.vocabulary).filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
    replacements: list(s.replacements).map(record).map((r) => ({ heard: text(r.heard, ''), written: text(r.written, '') })),
    snippets: list(s.snippets).map(record).map((r) => ({ trigger: text(r.trigger, ''), expansion: text(r.expansion, '') })),
    keepHistory: flag(s.keepHistory, DEFAULTS.keepHistory),
    sounds: flag(s.sounds, DEFAULTS.sounds),
    engine: {
      kind: oneOf(e.kind, ['local', 'cloud'], DEFAULTS.engine.kind),
      baseUrl: text(e.baseUrl, DEFAULTS.engine.baseUrl),
      model: text(e.model, DEFAULTS.engine.model),
      cleanupModel: text(e.cleanupModel, DEFAULTS.engine.cleanupModel),
    },
    unloadAfterMinutes: Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : DEFAULTS.unloadAfterMinutes,
    copyAutomatically: flag(s.copyAutomatically, DEFAULTS.copyAutomatically),
    hotkeys: normalizeHotkeys(s.hotkeys),
    microphoneId: text(s.microphoneId, ''),
    microphoneLabel: text(s.microphoneLabel, ''),
    restoreClipboard: flag(s.restoreClipboard, DEFAULTS.restoreClipboard),
    launchAtLogin: flag(s.launchAtLogin, DEFAULTS.launchAtLogin),
  }
}

/** Adds or removes one dictation key. The last remaining key cannot be removed. */
export function withHotkey(keys: readonly HotkeyId[], key: HotkeyId, enabled: boolean): HotkeyId[] {
  const next = keys.filter((k) => k !== key)
  if (enabled) next.push(key)
  return next.length ? normalizeHotkeys(next) : [...keys]
}

/** "Right Ctrl", "Right Ctrl or F13", "Right Ctrl, Right Alt or F13". */
export function hotkeyNames(keys: readonly HotkeyId[]): string {
  const names = HOTKEYS.filter((k) => keys.includes(k.id)).map((k) => k.label)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

/** Terms the recognizer and the cleanup pass should spell exactly: the dictionary plus what replacements produce. */
export function spellingHints(settings: Pick<Settings, 'vocabulary' | 'replacements'>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const term of [...settings.vocabulary, ...settings.replacements.map((r) => r.written)]) {
    const t = term.trim()
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase())
      out.push(t)
    }
  }
  return out
}
