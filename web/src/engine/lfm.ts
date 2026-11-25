import * as ort from 'onnxruntime-web/webgpu'
import { Tokenizer } from '@huggingface/tokenizers'
import { SAMPLE_RATE, segments } from '../core/audio'
import * as Cleanup from '../core/cleanup'
import { logMel, N_MELS } from './mel'

/**
 * LFM3-Audio-2B on WebGPU through ONNX Runtime Web: speech to text, and the optional second
 * pass that cleans the text. One instance holds the loaded model; calls must not overlap.
 *
 * The model is two graphs. The audio encoder turns a log-mel spectrogram into one embedding per
 * 80 ms. The decoder is the language model: it takes token ids, with those embeddings placed at
 * the <|audio|> tokens, and returns the next-token scores plus its caches, which are handed back
 * on the next call so each call only computes the new tokens.
 */
export interface ModelFiles {
  decoder: Uint8Array
  decoderData: Uint8Array
  encoder: Uint8Array
  encoderData: Uint8Array
  /** tokenizer.json, parsed. */
  tokenizer: object
}

export interface DictationResult {
  raw: string
  text: string
  audioSeconds: number
  asrMs: number
  cleanupMs: number
  /** Why the cleaned text was not used, when it was not. */
  note: string
}

export const DECODER_DATA_NAME = 'decoder_q4f16.onnx_data'
export const ENCODER_DATA_NAME = 'audio_encoder.onnx_data'

const AUDIO = 125031n
const END_OF_TURN = [124900, 125014] // <|im_end|>, <|text_end|>
const HIDDEN = 2048
/** The decoder's graph accepts at most this many new tokens per call on WebGPU. */
const MAX_FEED = 1024

type Cache = Record<string, ort.Tensor>

/** The decoder after reading some tokens: its caches, how many tokens, and the scores for the next one. */
interface State {
  cache: Cache
  length: number
  logits: Float32Array
  /** A kept state (the cleanup instructions) outlives the requests that continue from it. */
  kept: boolean
}

export async function describeGpu(): Promise<{ ok: boolean; reason: string; name: string }> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: GPU } | undefined)?.gpu
  if (!gpu) return { ok: false, reason: 'This browser has no WebGPU.', name: '' }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) return { ok: false, reason: 'WebGPU found no usable graphics adapter.', name: '' }
  const info = adapter.info
  const name = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ')
  // A software adapter would "work" at minutes per sentence; better to say so and offer the API.
  const software = (info as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter === true
    || /basic render|swiftshader|llvmpipe|software/i.test(name)
  if (software) {
    return { ok: false, reason: 'This computer only offers a software graphics adapter, which is far too slow for the model.', name }
  }
  if (!adapter.features.has('shader-f16')) {
    return { ok: false, reason: 'The graphics adapter lacks 16-bit float support (shader-f16), which the model needs.', name }
  }
  return { ok: true, reason: '', name }
}

export class Lfm {
  private prepared: State | undefined
  private preparedVocabulary = ''

  private constructor(
    private readonly encoder: ort.InferenceSession,
    private readonly decoder: ort.InferenceSession,
    private readonly tokenizer: Tokenizer,
    private readonly cacheInputs: string[],
  ) {}

  /** Compiles both graphs for the GPU. Slow (seconds, longer the first time). */
  static async create(files: ModelFiles, onStage?: (stage: string) => void): Promise<Lfm> {
    // Threads need a cross-origin isolated page, which static hosts rarely provide; the heavy
    // work is on the GPU either way.
    ort.env.wasm.numThreads = 1
    ort.env.webgpu.powerPreference = 'high-performance'
    const base: ort.InferenceSession.SessionOptions = {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    }
    onStage?.('Preparing the audio encoder')
    const encoder = await ort.InferenceSession.create(files.encoder, {
      ...base,
      externalData: [{ path: ENCODER_DATA_NAME, data: files.encoderData }],
    })
    onStage?.('Preparing the language model')
    const probe = cacheNames(files.decoder)
    const decoder = await ort.InferenceSession.create(files.decoder, {
      ...base,
      externalData: [{ path: DECODER_DATA_NAME, data: files.decoderData }],
      // The caches go straight back in on the next call, so they never leave the GPU.
      preferredOutputLocation: Object.fromEntries(probe.outputs.map((name) => [name, 'gpu-buffer' as const])),
    })
    const cacheInputs = decoder.inputNames.filter((name) => name.startsWith('past_'))
    const tokenizer = new Tokenizer(files.tokenizer as never, {} as never)
    return new Lfm(encoder, decoder, tokenizer, cacheInputs)
  }

  async dispose(): Promise<void> {
    this.release(this.prepared, true)
    this.prepared = undefined
    await this.encoder.release()
    await this.decoder.release()
  }

  /**
   * Speech to text. `language` is an English language name ("English", "French") or empty to
   * let the model decide. A long recording is cut at pauses and transcribed piece by piece;
   * `onPartial` receives the text so far as it grows.
   */
  async transcribe(samples: Float32Array, language: string, onPartial?: (text: string) => void): Promise<string> {
    const instruction = language.trim() ? `Perform ASR in ${language.trim()}.` : 'Perform ASR.'
    let done = ''
    for (const [from, to] of segments(samples)) {
      const features = logMel(samples, from, to)
      const encoded = await this.encoder.run({
        input_features: new ort.Tensor('float32', features.data, [1, N_MELS, features.frames]),
      })
      const audio = encoded.audio_features
      const embeddings = audio.data as Float32Array
      const count = audio.dims[0]
      const ids = [
        ...this.encode(`<|startoftext|><|im_start|>system\n${instruction}<|im_end|>\n<|im_start|>user\n`),
        ...new Array<bigint>(count).fill(AUDIO),
        ...this.encode('<|im_end|>\n<|im_start|>assistant\n'),
      ]
      const seconds = (to - from) / SAMPLE_RATE
      // Speech rarely exceeds 5 tokens per second; leave generous headroom.
      const budget = Math.min(512, Math.max(96, Math.floor(seconds * 12)))
      const prefix = done ? `${done} ` : ''
      const start = await this.advance(undefined, ids, embeddings)
      const piece = await this.generate(start, budget, onPartial && ((text) => onPartial(prefix + text)))
      if (piece) done = prefix + piece
    }
    return done
  }

  /**
   * Reads the cleanup instructions and examples ahead of time, so each cleanup only has to read
   * its transcript. The result is kept and continued from as often as needed.
   */
  async prepareCleanup(vocabulary: readonly string[]): Promise<void> {
    const key = JSON.stringify(vocabulary)
    if (this.prepared && this.preparedVocabulary === key) return
    this.release(this.prepared, true)
    this.prepared = undefined
    let preface = `<|startoftext|><|im_start|>system\n${Cleanup.system(vocabulary)}<|im_end|>\n`
    for (const [heard, written] of Cleanup.shots) {
      preface += `<|im_start|>user\n${Cleanup.wrap(heard)}<|im_end|>\n<|im_start|>assistant\n${written}<|im_end|>\n`
    }
    const state = await this.advance(undefined, this.encode(preface))
    state.kept = true
    this.prepared = state
    this.preparedVocabulary = key
  }

  /** The second pass. Returns the model's answer as it is; `Cleanup.rejection` judges it. */
  async cleanup(text: string, vocabulary: readonly string[]): Promise<string> {
    await this.prepareCleanup(vocabulary)
    const turn = this.encode(`<|im_start|>user\n${Cleanup.wrap(text)}<|im_end|>\n<|im_start|>assistant\n`)
    const start = await this.advance(this.prepared, turn)
    const budget = Math.floor(text.length / 2.5) + 48
    return Cleanup.unwrap(await this.generate(start, budget))
  }

  /**
   * The whole pipeline for one recording: recognize, then clean when `smart` is set, the
   * language is English and there is enough text for cleaning to matter.
   */
  async dictate(
    samples: Float32Array,
    options: { language: string; smart: boolean; vocabulary: readonly string[] },
    onPartial?: (text: string) => void,
  ): Promise<DictationResult> {
    const started = performance.now()
    const raw = (await this.transcribe(samples, options.language, onPartial)).trim()
    const asrMs = Math.round(performance.now() - started)
    let text = raw
    let note = ''
    let cleanupMs = 0
    // The cleanup examples are English; in other languages the model tends to translate, so
    // those keep the transcript as recognized.
    const english = !options.language.trim() || options.language === 'English'
    if (options.smart && english && Cleanup.words(raw).length >= 4) {
      const cleanupStarted = performance.now()
      const cleaned: string[] = []
      for (const piece of Cleanup.pieces(raw)) {
        const answer = await this.cleanup(piece, options.vocabulary)
        const why = Cleanup.rejection(piece, answer, options.vocabulary)
        if (why) note = `cleanup rejected (${why}); used the raw transcript`
        cleaned.push(why ? piece : answer)
      }
      text = cleaned.join(' ')
      cleanupMs = Math.round(performance.now() - cleanupStarted)
    }
    return { raw, text, audioSeconds: samples.length / SAMPLE_RATE, asrMs, cleanupMs, note }
  }

  private encode(text: string): bigint[] {
    return this.tokenizer.encode(text, { add_special_tokens: false }).ids.map((id) => BigInt(id))
  }

  /** Greedy decoding from `state` until the end of the turn. Consumes the state. */
  private async generate(state: State, maxTokens: number, onText?: (text: string) => void): Promise<string> {
    const out: number[] = []
    let current = state
    try {
      while (out.length < maxTokens) {
        const next = argmax(current.logits)
        if (END_OF_TURN.includes(next)) break
        out.push(next)
        if (onText) onText(this.decode(out))
        current = await this.advance(current, [BigInt(next)])
      }
    } finally {
      this.release(current)
    }
    return this.decode(out).trim()
  }

  private decode(ids: number[]): string {
    return this.tokenizer.decode(ids, { skip_special_tokens: true })
  }

  /**
   * Feeds `ids` to the decoder after `from` (or from an empty context) and returns the new
   * state. `audio` holds one embedding per <|audio|> token among the ids, in order. A state
   * that is not kept is released once the decoder has moved past it.
   */
  private async advance(from: State | undefined, ids: bigint[], audio?: Float32Array): Promise<State> {
    let state = from ?? this.emptyState()
    let audioUsed = 0
    for (let at = 0; at < ids.length; at += MAX_FEED) {
      const chunk = ids.slice(at, at + MAX_FEED)
      const audioCount = chunk.reduce((n, id) => n + (id === AUDIO ? 1 : 0), 0)
      const total = state.length + chunk.length
      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(chunk), [1, chunk.length]),
        attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
        position_ids: new ort.Tensor('int64', BigInt64Array.from(chunk, (_, i) => BigInt(state.length + i)), [1, chunk.length]),
        audio_features: new ort.Tensor(
          'float32',
          audio ? audio.subarray(audioUsed * HIDDEN, (audioUsed + audioCount) * HIDDEN) : new Float32Array(0),
          [audioCount, HIDDEN],
        ),
        audio_out_codes: new ort.Tensor('int64', new BigInt64Array(0), [0, 12]),
        logits_to_keep: new ort.Tensor('int64', BigInt64Array.from([1n]), [1]),
        ...state.cache,
      }
      audioUsed += audioCount
      const fetches = ['logits', ...this.cacheInputs.map(outputFor)]
      const results = await this.decoder.run(feeds, fetches)
      const cache: Cache = {}
      for (const name of this.cacheInputs) cache[name] = results[outputFor(name)]
      const logits = results.logits.data as Float32Array
      const next: State = { cache, length: total, logits, kept: false }
      this.release(state)
      state = next
    }
    return state
  }

  private emptyState(): State {
    const cache: Cache = {}
    for (const name of this.cacheInputs) {
      cache[name] = name.startsWith('past_conv')
        ? new ort.Tensor('float16', new Uint16Array(HIDDEN * 7), [1, HIDDEN, 7])
        : new ort.Tensor('float16', new Uint16Array(0), [1, 4, 0, 128])
    }
    return { cache, length: 0, logits: new Float32Array(0), kept: false }
  }

  private release(state: State | undefined, evenIfKept = false): void {
    if (!state || (state.kept && !evenIfKept)) return
    for (const tensor of Object.values(state.cache)) {
      if (tensor.location !== 'cpu') tensor.dispose()
    }
  }
}

/** past_conv.3 -> present_conv.3, past_key_values.2.key -> present.2.key */
function outputFor(input: string): string {
  return input.startsWith('past_conv') ? input.replace('past_conv', 'present_conv') : input.replace('past_key_values', 'present')
}

/**
 * The names of the decoder's cache outputs, read from the graph file before the session exists,
 * because the session has to be told at creation which outputs stay on the GPU.
 */
function cacheNames(graph: Uint8Array): { outputs: string[] } {
  const text = new TextDecoder('latin1').decode(graph)
  const outputs = new Set<string>()
  for (const match of text.matchAll(/present(?:_conv\.\d+|\.\d+\.(?:key|value))/g)) outputs.add(match[0])
  return { outputs: [...outputs] }
}

function argmax(values: Float32Array): number {
  let best = 0
  let bestValue = -Infinity
  for (let i = 0; i < values.length; i++) {
    if (values[i] > bestValue) {
      bestValue = values[i]
      best = i
    }
  }
  return best
}
