import { SAMPLE_RATE } from '../core/audio'
import { fit, process } from '../core/postprocess'
import { spellingHints, type Settings } from '../core/settings'
import { containsSpeech } from '../core/speechGate'
import { TriggerMachine, type TriggerAction, type TriggerInput } from '../core/trigger'
import type { Engine } from './engine'
import { addToHistory, type HistoryEntry } from './persist'
import { desktop, PILL_CHANNEL, type KeyEvent, type Phase, type PillState } from './platform'
import { Recorder } from './recorder'
import { Store } from './store'

/** How long a single tap waits for its second tap, in milliseconds. */
const TAP_WINDOW = 350
const LEVELS = 28

const INPUTS: Record<KeyEvent, TriggerInput> = { down: 'keyDown', up: 'keyUp', escape: 'escape', other: 'otherKey' }

/**
 * One dictation from key press to text: the key's state machine, the microphone, the engine and
 * the text rules. The interface watches its stores; where the text goes is up to `deliver`.
 */
export class Dictation {
  readonly phase = new Store<Phase>('idle')
  /** The words so far, while the engine is working. */
  readonly partial = new Store('')
  /** A short message for the user; clears itself. */
  readonly notice = new Store('')
  readonly levels = new Store<number[]>([])

  /** Puts the finished text where it belongs. */
  deliver: (text: string) => void | Promise<void> = () => {}
  /** The text left of the cursor when it can be known, so the new text can continue it. */
  before: () => string | null = () => null

  private readonly machine = new TriggerMachine()
  private readonly recorder = new Recorder()
  private readonly pill = new BroadcastChannel(PILL_CHANNEL)
  private tapTimer: ReturnType<typeof setTimeout> | undefined
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  /** Increases whenever the dictation in flight is abandoned, so its late result is ignored. */
  private run = 0
  private audio: AudioContext | undefined
  private wakeLock: WakeLockSentinel | undefined
  private wakeLockWanted = false

  constructor(
    private readonly settings: Store<Settings>,
    private readonly history: Store<HistoryEntry[]>,
    private readonly engine: Engine,
  ) {
    this.recorder.onLevel = (level) => {
      this.levels.update((all) => [...all.slice(-(LEVELS - 1)), level])
      this.announce()
    }
    this.recorder.onLimit = () => this.input('limitReached')
    this.phase.subscribe(() => this.announce())
    this.phase.subscribe((phase) => void this.keepAwake(phase !== 'idle'))
    this.notice.subscribe(() => this.announce())
  }

  /** The dictation key, from the system-wide listener or from the page's own key events. */
  key(event: KeyEvent): void {
    this.input(INPUTS[event])
  }

  /** The on-screen microphone: hold it to talk, or tap it to start and tap again to finish. */
  buttonDown(): void {
    this.input('keyDown')
  }

  buttonUp(): void {
    if (this.machine.state !== 'holding') return
    const actions = this.machine.handle('keyUp', performance.now())
    if (actions.includes('startTapWindow')) {
      // A tap on a button is deliberate; there is no second tap to wait for.
      this.apply(this.machine.handle('keyDown', performance.now()))
    } else {
      this.apply(actions)
    }
  }

  cancel(): void {
    this.input('escape')
  }

  private input(input: TriggerInput): void {
    this.apply(this.machine.handle(input, performance.now()))
  }

  private apply(actions: TriggerAction[]): void {
    for (const action of actions) {
      switch (action) {
        case 'startRecording': this.start(); break
        case 'finishRecording': this.finish(); break
        case 'discardQuietly': this.discard(''); break
        case 'discardRecording': this.discard('Cancelled'); break
        case 'abandonProcessing':
          this.run++
          this.partial.set('')
          this.phase.set('idle')
          this.say('Cancelled')
          break
        case 'startTapWindow':
          this.tapTimer = setTimeout(() => this.input('tapWindowExpired'), TAP_WINDOW)
          break
        case 'stopTapWindow': clearTimeout(this.tapTimer); break
        case 'enteredHandsFree': this.phase.set('handsFree'); break
      }
    }
  }

  private start(): void {
    this.say('')
    this.levels.set([])
    this.partial.set('')
    this.phase.set('recording')
    void this.engine.warm()
    this.recorder.start(this.settings.value.microphoneId).then(
      () => this.beep(660),
      (error) => {
        this.machine.reset()
        clearTimeout(this.tapTimer)
        this.phase.set('idle')
        this.say(error?.name === 'NotAllowedError' ? 'The microphone is not allowed' : 'The microphone is not available')
      },
    )
  }

  private discard(message: string): void {
    this.recorder.stop()
    this.phase.set('idle')
    if (message) this.say(message)
  }

  private finish(): void {
    const samples = this.recorder.stop()
    this.phase.set('processing')
    this.beep(440)
    const run = ++this.run
    const end = (message = '') => {
      if (run !== this.run) return
      this.machine.handle('processingEnded', performance.now())
      this.partial.set('')
      this.phase.set('idle')
      if (message) this.say(message)
    }
    // Silence and noise never reach the engine: it would invent a sentence for them.
    if (samples.length < SAMPLE_RATE * 0.3 || !containsSpeech(samples)) {
      end("Didn't hear anything")
      return
    }
    const seconds = samples.length / SAMPLE_RATE
    const started = performance.now()
    this.engine.dictate(samples, (text) => run === this.run && this.partial.set(text)).then(
      async (result) => {
        if (run !== this.run) return
        const s = this.settings.value
        const processed = process(result.text, { cleanup: s.cleanup, tone: s.tone, replacements: s.replacements, snippets: s.snippets })
        if (!processed) {
          end('Nothing to type')
          return
        }
        await this.deliver(fit(processed, this.before(), spellingHints(s)))
        if (s.keepHistory) {
          addToHistory(this.history, {
            text: processed, raw: result.raw, at: Date.now(), audioSeconds: seconds, ms: Math.round(performance.now() - started),
          })
        }
        end()
      },
      (error) => end(error instanceof Error ? error.message : String(error)),
    )
  }

  private say(message: string): void {
    clearTimeout(this.noticeTimer)
    this.notice.set(message)
    if (message) this.noticeTimer = setTimeout(() => this.notice.set(''), 4000)
  }

  /** Whether the screen is being kept on right now. */
  get keepingAwake(): boolean {
    return this.wakeLock !== undefined && !this.wakeLock.released
  }

  /**
   * In a browser, keeps the screen on while Sotto listens and until the text is in place: a long
   * dictation involves no typing, and a computer that falls asleep stops the recording. (The
   * Windows app does the same from its main process, which also works with the window hidden.)
   */
  private async keepAwake(on: boolean): Promise<void> {
    this.wakeLockWanted = on
    if (desktop || !('wakeLock' in navigator)) return
    if (!on) {
      const held = this.wakeLock
      this.wakeLock = undefined
      await held?.release().catch(() => undefined)
      return
    }
    if (this.keepingAwake) return
    try {
      const lock = await navigator.wakeLock.request('screen')
      // The dictation may have ended while the browser was answering.
      if (this.wakeLockWanted) this.wakeLock = lock
      else await lock.release()
    } catch {
      // Refused (a hidden tab, a battery saver): dictation goes on without it.
    }
  }

  private announce(): void {
    const state: PillState = { phase: this.phase.value, levels: this.levels.value, notice: this.notice.value }
    this.pill.postMessage(state)
  }

  /** A short soft tone at the start and the end of a recording. */
  private beep(frequency: number): void {
    if (!this.settings.value.sounds) return
    try {
      const context = (this.audio ??= new AudioContext())
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.13)
    } catch {
      // No sound is not worth an error.
    }
  }
}
