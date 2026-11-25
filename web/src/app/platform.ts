import type { HotkeyId } from '../core/settings'
import type { HttpRequest } from '../engine/cloud'

export type Phase = 'idle' | 'recording' | 'handsFree' | 'processing'
export type KeyEvent = 'down' | 'up' | 'escape' | 'other'

/**
 * What the Windows app adds to the page, provided by its preload script as `window.sottoDesktop`.
 * In a plain browser it is absent, and the page is a dictation pad.
 */
export interface DesktopBridge {
  readonly os: string
  readonly version: string
  /** Types `text` into whatever app has the keyboard, by way of the clipboard. */
  paste(text: string, restoreClipboard: boolean): Promise<void>
  /** A request made by the app itself, which is not bound by the browser's cross-origin rules. */
  http(request: HttpRequest): Promise<{ status: number; body: string }>
  getSecret(name: string): Promise<string>
  setSecret(name: string, value: string): Promise<void>
  configure(options: { hotkeys: HotkeyId[]; launchAtLogin: boolean }): void
  /** Lets the tray icon and the floating indicator follow along. */
  setPhase(phase: Phase): void
  /** Whether the system-wide key listener is running, and why not if it is not. */
  keyListener(): Promise<{ ok: boolean; message: string }>
  onKey(listener: (event: KeyEvent) => void): void
  onCommand(listener: (command: string) => void): void
}

export const desktop: DesktopBridge | undefined = (globalThis as { sottoDesktop?: DesktopBridge }).sottoDesktop

/** What the floating indicator shows; sent to its window over a BroadcastChannel. */
export interface PillState {
  phase: Phase
  /** Recent loudness, oldest first, each 0..1. */
  levels: number[]
  /** A short message that replaces the animation ("Didn't hear anything"). */
  notice: string
}

export const PILL_CHANNEL = 'sotto-pill'
