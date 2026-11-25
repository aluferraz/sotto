/**
 * Decides whether a recording contains speech at all, from the loudness of its 20 ms frames.
 * The model, like every speech recognizer, invents a plausible sentence when handed silence or
 * steady noise, so those clips must not reach it.
 */
/** Loud enough that it is speech whatever the background (about -34 dBFS). */
export const CLEARLY_LOUD = 0.02
/** Below this nothing was said, not even a whisper (about -48 dBFS). */
export const AUDIBLE = 0.004
/** Speech rises and falls; fan noise does not. Speech frames must stand this far above the quiet ones. */
export const CONTRAST = 3
/** The shortest words last about 200 ms. Clicks last 20 to 40 ms. */
export const MINIMUM_ACTIVE_FRAMES = 10
/** 20 ms at 16 kHz. */
export const FRAME = 320

export interface Stats {
  /** Loudness of the quietest tenth of the frames: the room. */
  floor: number
  /** Frames that stand clearly above the room. */
  activeFrames: number
  /** Frames loud enough to be speech in any room. */
  loudFrames: number
  containsSpeech: boolean
}

export function analyze(frameRms: Float32Array): Stats {
  if (frameRms.length === 0) return { floor: 0, activeFrames: 0, loudFrames: 0, containsSpeech: false }
  const sorted = Float32Array.from(frameRms).sort()
  const floor = sorted[Math.floor((sorted.length - 1) * 0.1)]
  const threshold = Math.max(AUDIBLE, floor * CONTRAST)
  let activeFrames = 0
  let loudFrames = 0
  for (const v of frameRms) {
    if (v >= threshold) activeFrames++
    if (v >= CLEARLY_LOUD) loudFrames++
  }
  const containsSpeech = activeFrames >= MINIMUM_ACTIVE_FRAMES || loudFrames >= MINIMUM_ACTIVE_FRAMES
  return { floor, activeFrames, loudFrames, containsSpeech }
}

/** Root-mean-square loudness (0..1) of consecutive windows of `size` samples. */
export function frames(samples: Float32Array, size = FRAME): Float32Array {
  if (size <= 0 || samples.length < size) return new Float32Array(0)
  const out = new Float32Array(Math.floor(samples.length / size))
  for (let f = 0; f < out.length; f++) {
    let sum = 0
    for (let i = f * size; i < (f + 1) * size; i++) sum += samples[i] * samples[i]
    out[f] = Math.sqrt(sum / size)
  }
  return out
}

export const containsSpeech = (samples: Float32Array) => analyze(frames(samples)).containsSpeech
