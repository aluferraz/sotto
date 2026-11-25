/**
 * A page for testing the engine without the interface: the test runner (test/run-engine.cjs)
 * loads it in a hidden window and calls these functions.
 */
import { decodeWav } from './core/audio'
import * as Cleanup from './core/cleanup'
import { describeGpu, Lfm } from './engine/lfm'
import { logMel } from './engine/mel'

let model: Lfm | undefined

async function bytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

const harness = {
  gpu: describeGpu,

  /** Features of a WAV file, for comparison with the reference implementation. */
  async mel(url: string) {
    const samples = decodeWav(await bytes(url))
    const started = performance.now()
    const features = logMel(samples)
    return { frames: features.frames, ms: performance.now() - started, data: Array.from(features.data) }
  },

  async load(base: string) {
    const started = performance.now()
    const [decoder, decoderData, encoder, encoderData, tokenizer] = await Promise.all([
      bytes(`${base}decoder_q4f16.onnx`), bytes(`${base}decoder_q4f16.onnx_data`),
      bytes(`${base}audio_encoder.onnx`), bytes(`${base}audio_encoder.onnx_data`),
      fetch(`${base}tokenizer.json`).then((r) => r.json()),
    ])
    const read = performance.now()
    model = await Lfm.create({ decoder, decoderData, encoder, encoderData, tokenizer })
    return { readMs: Math.round(read - started), compileMs: Math.round(performance.now() - read) }
  },

  async dictate(url: string, smart: boolean, language = 'English') {
    const samples = decodeWav(await bytes(url))
    let partials = 0
    const result = await model!.dictate(samples, { language, smart, vocabulary: [] }, () => partials++)
    return { ...result, partials }
  },

  async prepare(vocabulary: string[]) {
    const started = performance.now()
    await model!.prepareCleanup(vocabulary)
    return Math.round(performance.now() - started)
  },

  async cleanup(text: string, vocabulary: string[]) {
    const started = performance.now()
    const cleaned = await model!.cleanup(text, vocabulary)
    return { cleaned, ms: Math.round(performance.now() - started), rejected: Cleanup.rejection(text, cleaned, vocabulary) }
  },
}

;(window as unknown as { harness: typeof harness }).harness = harness
