/** Audio helpers. Everything downstream works on mono 32-bit floats at 16 kHz. */
export const SAMPLE_RATE = 16_000

/** Recordings longer than this are transcribed in pieces, cut at pauses. */
export const MAX_SEGMENT_SAMPLES = 28 * SAMPLE_RATE

/** A complete 16-bit mono WAV file. */
export function encodeWav(samples: Float32Array, from = 0, to = samples.length): Uint8Array {
  const n = to - from
  const bytes = new Uint8Array(44 + n * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i) }
  text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[from + i]))
    view.setInt16(44 + i * 2, Math.round(v * 32767), true)
  }
  return bytes
}

/** Reads a WAV file (16-bit PCM or 32-bit float). Stereo is mixed down; other rates are resampled. */
export function decodeWav(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
  if (bytes.length <= 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let pos = 12
  let channels = 1
  let rate = SAMPLE_RATE
  let bits = 16
  let float = false
  while (pos + 8 <= bytes.length) {
    const id = tag(pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      const format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      rate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      float = format === 3
      if (!((format === 1 && bits === 16) || (float && bits === 32))) {
        throw new Error('only 16-bit PCM and 32-bit float WAV are supported')
      }
    } else if (id === 'data') {
      const width = bits / 8
      const length = Math.min(size, bytes.length - body)
      const frames = Math.floor(length / (width * channels))
      const mono = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        let sum = 0
        for (let c = 0; c < channels; c++) {
          const at = body + (f * channels + c) * width
          sum += float ? view.getFloat32(at, true) : view.getInt16(at, true) / 32768
        }
        mono[f] = sum / channels
      }
      return resample(mono, rate)
    }
    pos = body + size + (size & 1)
  }
  throw new Error('WAV file has no audio')
}

/** Linear resampling to 16 kHz. Good enough for speech; the microphone path asks for 16 kHz directly. */
export function resample(samples: Float32Array, rate: number): Float32Array {
  if (rate === SAMPLE_RATE) return samples
  const out = new Float32Array(Math.floor((samples.length * SAMPLE_RATE) / rate))
  for (let i = 0; i < out.length; i++) {
    const at = (i * rate) / SAMPLE_RATE
    const a = Math.min(Math.floor(at), samples.length - 1)
    const b = Math.min(a + 1, samples.length - 1)
    out[i] = samples[a] + (samples[b] - samples[a]) * (at - a)
  }
  return out
}

/**
 * Cuts a recording into stretches of at most `maxSamples`, each cut placed in the quietest half
 * second of the last eight seconds, so a word is not split between two pieces.
 */
export function segments(samples: Float32Array, maxSamples = MAX_SEGMENT_SAMPLES): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const count = samples.length
  const window = SAMPLE_RATE / 2
  let start = 0
  while (count - start > maxSamples) {
    let best = start + maxSamples
    let bestEnergy = Infinity
    for (let at = start + maxSamples - 8 * SAMPLE_RATE; at + window <= start + maxSamples; at += window / 4) {
      let energy = 0
      for (let i = at; i < at + window; i++) energy += samples[i] * samples[i]
      if (energy < bestEnergy) {
        bestEnergy = energy
        best = at + window / 2
      }
    }
    out.push([start, best])
    start = best
  }
  if (count > start) out.push([start, count])
  return out
}
