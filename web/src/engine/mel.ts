/**
 * The log-mel spectrogram LFM3-Audio's speech encoder was trained on, as its reference feature
 * extractor computes it: a 25 ms periodic Hann window every 10 ms without centering, 128 Slaney
 * mel filters over 0 to 8 kHz, a base-10 logarithm clamped at -12, then (x + 4) / 4. The clip is
 * right-padded with zeros so no trailing samples are dropped.
 */
export const SAMPLE_RATE = 16_000
export const N_MELS = 128
/** Spectrogram frames per token the encoder produces. */
export const ENCODER_STRIDE = 8

const N_FFT = 400
const HOP = 160
const BINS = N_FFT / 2 + 1
const LOG_FLOOR = -12
const OFFSET = 4
const DIVISOR = 4

export function paddedLength(samples: number): number {
  if (samples < N_FFT) return N_FFT
  const over = (samples - N_FFT) % HOP
  return over === 0 ? samples : samples + HOP - over
}

export function frameCount(samples: number): number {
  return 1 + (paddedLength(samples) - N_FFT) / HOP
}

export function encoderTokens(frames: number): number {
  return Math.ceil(frames / ENCODER_STRIDE)
}

function hertzToMel(hz: number): number {
  return hz < 1000 ? (3 * hz) / 200 : 15 + (Math.log(hz / 1000) * 27) / Math.log(6.4)
}

function melToHertz(mel: number): number {
  return mel < 15 ? (200 * mel) / 3 : 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15))
}

interface Filter {
  /** First spectrum bin with a non-zero weight. */
  start: number
  weights: Float64Array
}

/** Triangular filters with Slaney area normalization, stored as their non-zero stretch. */
function melFilters(): Filter[] {
  const low = hertzToMel(0)
  const high = hertzToMel(SAMPLE_RATE / 2)
  const edges = new Float64Array(N_MELS + 2)
  for (let i = 0; i < edges.length; i++) edges[i] = melToHertz(low + ((high - low) * i) / (N_MELS + 1))
  const filters: Filter[] = []
  for (let m = 0; m < N_MELS; m++) {
    const [left, centre, right] = [edges[m], edges[m + 1], edges[m + 2]]
    const norm = 2 / (right - left)
    const dense = new Float64Array(BINS)
    let start = -1
    let end = 0
    for (let k = 0; k < BINS; k++) {
      const hz = (k * (SAMPLE_RATE / 2)) / (BINS - 1)
      const weight = Math.max(0, Math.min((hz - left) / (centre - left), (right - hz) / (right - centre)))
      if (weight > 0) {
        if (start < 0) start = k
        end = k + 1
        dense[k] = weight * norm
      }
    }
    filters.push(start < 0 ? { start: 0, weights: new Float64Array(0) } : { start, weights: dense.slice(start, end) })
  }
  return filters
}

interface Tables {
  window: Float64Array
  /** cos(2πkn/400) and sin(2πkn/400) for k in 0..200 and n in 0..199, row by row. */
  cos: Float64Array
  sin: Float64Array
  filters: Filter[]
}

let tables: Tables | undefined

function prepare(): Tables {
  if (tables) return tables
  const window = new Float64Array(N_FFT)
  for (let n = 0; n < N_FFT; n++) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT)
  const half = N_FFT / 2
  const cos = new Float64Array(BINS * half)
  const sin = new Float64Array(BINS * half)
  for (let k = 0; k < BINS; k++) {
    for (let n = 0; n < half; n++) {
      // Reduce the angle first: k·n reaches 40,000 and sin(2πx) loses digits at that size.
      const angle = (2 * Math.PI * ((k * n) % N_FFT)) / N_FFT
      cos[k * half + n] = Math.cos(angle)
      sin[k * half + n] = Math.sin(angle)
    }
  }
  tables = { window, cos, sin, filters: melFilters() }
  return tables
}

export interface Features {
  /** [1, 128, frames], mel band by mel band. */
  data: Float32Array
  frames: number
}

/** `samples` are mono floats in -1..1 at 16 kHz; `from` and `to` select a stretch of them. */
export function logMel(samples: Float32Array, from = 0, to = samples.length): Features {
  const { window, cos, sin, filters } = prepare()
  const length = to - from
  const frames = frameCount(length)
  const data = new Float32Array(N_MELS * frames)
  const half = N_FFT / 2
  // A 400-point transform is not a power of two, so it is done directly, using the symmetry
  // of the cosine and the antisymmetry of the sine around n = 200 to halve the work.
  const even = new Float64Array(half)
  const odd = new Float64Array(half)
  const power = new Float64Array(BINS)
  for (let f = 0; f < frames; f++) {
    const base = from + f * HOP
    const at = (n: number) => (base + n < to ? samples[base + n] * window[n] : 0)
    const first = at(0)
    const middle = at(half)
    for (let n = 1; n < half; n++) {
      const a = at(n)
      const b = at(N_FFT - n)
      even[n] = a + b
      odd[n] = a - b
    }
    for (let k = 0; k < BINS; k++) {
      let re = first + (k % 2 === 0 ? middle : -middle)
      let im = 0
      const row = k * half
      for (let n = 1; n < half; n++) {
        re += even[n] * cos[row + n]
        im -= odd[n] * sin[row + n]
      }
      power[k] = re * re + im * im
    }
    for (let m = 0; m < N_MELS; m++) {
      const { start, weights } = filters[m]
      let sum = 0
      for (let i = 0; i < weights.length; i++) sum += weights[i] * power[start + i]
      const log = sum > 0 ? Math.max(Math.log10(sum), LOG_FLOOR) : LOG_FLOOR
      data[m * frames + f] = (log + OFFSET) / DIVISOR
    }
  }
  return { data, frames }
}
