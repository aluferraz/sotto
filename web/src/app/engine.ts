import { spellingHints, type Settings } from '../core/settings'
import * as Cloud from '../engine/cloud'
import { describeGpu, type DictationResult } from '../engine/lfm'
import { DEFAULT_BASE, MODEL_BYTES } from '../engine/modelStore'
import type { FromWorker, Reply, Request, ToWorker } from '../engine/protocol'
import { Store } from './store'

export type EngineState =
  | { kind: 'checking' }
  /** The audio goes to an API. `problem` says what is missing from its settings, if anything. */
  | { kind: 'cloud'; problem: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'absent'; bytes: number; total: number }
  | { kind: 'downloading'; bytes: number; total: number; verifying: boolean }
  /** Downloaded, but not in memory. */
  | { kind: 'resting' }
  | { kind: 'loading'; stage: string }
  | { kind: 'ready'; gpu: string; loadMs: number }
  | { kind: 'failed'; message: string }

interface Pending {
  resolve: (reply: Reply) => void
  reject: (error: Error) => void
  onProgress?: (progress: { bytes: number; total: number; stage: 'downloading' | 'verifying' }) => void
  onStage?: (stage: string) => void
  onPartial?: (text: string) => void
}

/** Where the model files come from. `?model=URL` overrides it, for testing against a local copy. */
function modelBase(): string {
  return new URLSearchParams(location.search).get('model') ?? DEFAULT_BASE
}

/**
 * The page's side of the speech engine: starts the worker, follows the model from download to
 * loaded, and routes each recording to the local model or to the configured API.
 */
export class Engine {
  readonly state = new Store<EngineState>({ kind: 'checking' })

  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private loading: Promise<void> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private apiKey = ''

  /**
   * `http` is how requests to an OpenAI-compatible API leave. The Windows app provides one; the
   * browser version has none and always uses the model on this computer.
   */
  constructor(
    private readonly settings: Store<Settings>,
    private readonly http?: Cloud.Http,
  ) {
    let last = settings.value.engine
    settings.subscribe((value) => {
      if (value.engine !== last) {
        last = value.engine
        void this.refresh()
      }
    })
  }

  setApiKey(key: string): void {
    this.apiKey = key
  }

  /** Whether recordings go to an API instead of the local model. */
  get usesApi(): boolean {
    return this.http !== undefined && this.settings.value.engine.kind === 'cloud'
  }

  private cloudConfig(): Cloud.CloudConfig {
    return { ...this.settings.value.engine, apiKey: this.apiKey }
  }

  private call(request: Request, handlers: Omit<Pending, 'resolve' | 'reject'> = {}, transfer: Transferable[] = []): Promise<Reply> {
    if (!this.worker) {
      this.worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data)
      this.worker.onerror = (event) => {
        for (const p of this.pending.values()) p.reject(new Error(event.message || 'The engine stopped unexpectedly.'))
        this.pending.clear()
      }
    }
    const id = this.nextId++
    const message: ToWorker = { id, request, base: modelBase() }
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...handlers })
      this.worker!.postMessage(message, transfer)
    })
  }

  private receive(message: FromWorker): void {
    const waiting = this.pending.get(message.id)
    if (!waiting) return
    if ('reply' in message) {
      this.pending.delete(message.id)
      waiting.resolve(message.reply)
    } else if ('error' in message) {
      this.pending.delete(message.id)
      waiting.reject(new Error(message.error))
    } else if ('progress' in message) waiting.onProgress?.(message.progress)
    else if ('stage' in message) waiting.onStage?.(message.stage)
    else waiting.onPartial?.(message.partial)
  }

  /** Works out where things stand: which engine, whether the GPU can run it, what is on disk. */
  async refresh(): Promise<void> {
    if (this.usesApi) {
      this.state.set({ kind: 'cloud', problem: Cloud.problem(this.cloudConfig()) })
      return
    }
    const current = this.state.value.kind
    if (current === 'downloading' || current === 'loading' || current === 'ready') return
    try {
      const gpu = await describeGpu()
      if (!gpu.ok) {
        this.state.set({ kind: 'unsupported', reason: gpu.reason })
        return
      }
      const reply = await this.call({ type: 'status' })
      if (reply.type !== 'status') return
      this.state.set(reply.status.ready ? { kind: 'resting' } : { kind: 'absent', bytes: reply.status.bytes, total: reply.status.total })
    } catch (error) {
      this.state.set({ kind: 'failed', message: messageOf(error) })
    }
  }

  async download(): Promise<void> {
    if (this.state.value.kind === 'downloading') return
    const before = this.state.value
    this.state.set({ kind: 'downloading', bytes: before.kind === 'absent' ? before.bytes : 0, total: MODEL_BYTES, verifying: false })
    // Ask the browser not to evict the model when storage runs low.
    void navigator.storage.persist?.()
    try {
      await this.call({ type: 'download' }, {
        onProgress: (p) => this.state.set({ kind: 'downloading', bytes: p.bytes, total: p.total, verifying: p.stage === 'verifying' }),
      })
      this.state.set({ kind: 'resting' })
      void this.warm()
    } catch (error) {
      if (messageOf(error) === 'cancelled') {
        this.state.set({ kind: 'checking' })
        await this.refresh()
      } else {
        this.state.set({ kind: 'failed', message: messageOf(error) })
      }
    }
  }

  cancelDownload(): void {
    void this.call({ type: 'cancelDownload' })
  }

  async remove(): Promise<void> {
    await this.call({ type: 'remove' }).catch(() => undefined)
    this.state.set({ kind: 'checking' })
    await this.refresh()
  }

  /** Loads the model if it is downloaded and not in memory. Safe to call often. */
  warm(): Promise<void> {
    this.restartIdleTimer()
    const kind = this.state.value.kind
    if (kind !== 'resting' && kind !== 'failed') return this.loading ?? Promise.resolve()
    if (this.loading) return this.loading
    this.state.set({ kind: 'loading', stage: 'Starting' })
    this.loading = this.call({ type: 'load' }, { onStage: (stage) => this.state.set({ kind: 'loading', stage }) })
      .then((reply) => {
        if (reply.type === 'loaded') this.state.set({ kind: 'ready', gpu: reply.gpu, loadMs: reply.loadMs })
        this.prepare()
      })
      .catch((error) => this.state.set({ kind: 'failed', message: messageOf(error) }))
      .finally(() => (this.loading = undefined))
    return this.loading
  }

  /** While nobody is waiting, has the model read the cleanup instructions for the next dictation. */
  private prepare(): void {
    const s = this.settings.value
    const english = !s.language || s.language === 'English'
    if (s.cleanup !== 'smart' || !english || this.state.value.kind !== 'ready') return
    void this.call({ type: 'prepare', vocabulary: spellingHints(s) }).catch(() => undefined)
  }

  private restartIdleTimer(): void {
    clearTimeout(this.idleTimer)
    const minutes = this.settings.value.unloadAfterMinutes
    if (minutes <= 0) return
    this.idleTimer = setTimeout(() => {
      if (this.state.value.kind !== 'ready') return
      void this.call({ type: 'unload' }).then(() => this.state.set({ kind: 'resting' }))
    }, minutes * 60_000)
  }

  /** Recognizes one recording with whichever engine is selected. */
  async dictate(samples: Float32Array, onPartial: (text: string) => void): Promise<DictationResult> {
    const s = this.settings.value
    const options = { language: s.language, smart: s.cleanup === 'smart', vocabulary: spellingHints(s) }
    if (this.usesApi) {
      const config = this.cloudConfig()
      const problem = Cloud.problem(config)
      if (problem) throw new Error(problem)
      return Cloud.dictate(this.http!, config, samples, options)
    }
    await this.warm()
    const state = this.state.value
    if (state.kind !== 'ready') {
      throw new Error(state.kind === 'failed' ? state.message
        : state.kind === 'unsupported' ? state.reason
        : 'The speech model is not downloaded yet.')
    }
    const reply = await this.call({ type: 'dictate', samples, ...options }, { onPartial }, [samples.buffer as ArrayBuffer])
    this.restartIdleTimer()
    this.prepare()
    if (reply.type !== 'result') throw new Error('The engine gave no result.')
    return reply.result
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
