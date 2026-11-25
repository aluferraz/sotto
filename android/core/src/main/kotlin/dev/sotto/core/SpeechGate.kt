package dev.sotto.core

import kotlin.math.max
import kotlin.math.sqrt

/**
 * Decides whether a recording contains speech at all, from the loudness of its 20 ms frames.
 * The model, like every speech recognizer, invents a plausible sentence when handed silence or
 * steady noise, so those clips must not reach it. Mirrors Sources/SottoCore/SpeechGate.swift.
 */
object SpeechGate {
    /** Loud enough that it is speech whatever the background (about -34 dBFS). */
    const val CLEARLY_LOUD = 0.02f

    /** Below this nothing was said, not even a whisper (about -48 dBFS). */
    const val AUDIBLE = 0.004f

    /** Speech rises and falls; fan noise does not. Speech frames must stand this far above the quiet ones. */
    const val CONTRAST = 3f

    /** The shortest words last about 200 ms. Taps on the screen last 20 to 40 ms. */
    const val MINIMUM_ACTIVE_FRAMES = 10

    /** 20 ms at 16 kHz. */
    const val FRAME = 320

    data class Stats(
        /** Loudness of the quietest tenth of the frames: the room. */
        val floor: Float,
        /** Frames that stand clearly above the room. */
        val activeFrames: Int,
        /** Frames loud enough to be speech in any room. */
        val loudFrames: Int,
        val containsSpeech: Boolean,
    )

    fun analyze(frameRms: FloatArray): Stats {
        if (frameRms.isEmpty()) return Stats(0f, 0, 0, false)
        val sorted = frameRms.sortedArray()
        val floor = sorted[((sorted.size - 1) * 0.10f).toInt()]
        val threshold = max(AUDIBLE, floor * CONTRAST)
        val active = frameRms.count { it >= threshold }
        val loud = frameRms.count { it >= CLEARLY_LOUD }
        return Stats(floor, active, loud, active >= MINIMUM_ACTIVE_FRAMES || loud >= MINIMUM_ACTIVE_FRAMES)
    }

    fun containsSpeech(frameRms: FloatArray) = analyze(frameRms).containsSpeech

    /** Root-mean-square loudness (0..1) of consecutive windows of [size] samples. */
    fun frames(samples: ShortArray, count: Int = samples.size, size: Int = FRAME): FloatArray {
        if (size <= 0 || count < size) return FloatArray(0)
        val out = FloatArray(count / size)
        for (f in out.indices) {
            var sum = 0.0
            val start = f * size
            for (i in start until start + size) {
                val v = samples[i] / 32768.0
                sum += v * v
            }
            out[f] = sqrt(sum / size).toFloat()
        }
        return out
    }
}
