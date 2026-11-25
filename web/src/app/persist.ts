import { DEFAULTS, normalize, type Settings } from '../core/settings'
import { desktop } from './platform'
import { Store } from './store'

const SETTINGS = 'sotto.settings'
const HISTORY = 'sotto.history'
const API_KEY = 'apiKey'
const MAX_HISTORY = 200

export interface HistoryEntry {
  text: string
  raw: string
  /** Milliseconds since 1970. */
  at: number
  audioSeconds: number
  /** How long recognition and cleanup took. */
  ms: number
}

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

export function createSettings(): Store<Settings> {
  const store = new Store<Settings>(normalize(read(SETTINGS) ?? DEFAULTS))
  store.subscribe((value) => localStorage.setItem(SETTINGS, JSON.stringify(value)))
  return store
}

export function createHistory(): Store<HistoryEntry[]> {
  const stored = read(HISTORY)
  const store = new Store<HistoryEntry[]>(Array.isArray(stored) ? (stored as HistoryEntry[]) : [])
  store.subscribe((value) => localStorage.setItem(HISTORY, JSON.stringify(value)))
  return store
}

export function addToHistory(history: Store<HistoryEntry[]>, entry: HistoryEntry): void {
  history.update((entries) => [entry, ...entries].slice(0, MAX_HISTORY))
}

/**
 * The API key, which only the Windows app has: it keeps it encrypted with the user's Windows
 * account, and reads it only when the API is the selected engine or is being set up.
 */
export async function loadApiKey(): Promise<string> {
  return desktop ? desktop.getSecret(API_KEY) : ''
}

export async function saveApiKey(value: string): Promise<void> {
  await desktop?.setSecret(API_KEY, value)
}
