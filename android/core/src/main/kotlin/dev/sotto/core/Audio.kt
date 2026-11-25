package dev.sotto.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** 16 kHz mono 16-bit audio helpers: the format the microphone is read in and the model expects. */
object Audio {
    const val SAMPLE_RATE = 16_000

    /** The model reads audio in 30 s windows; segments stay a little under that. */
    const val MAX_SEGMENT_SAMPLES = 28 * SAMPLE_RATE

    /** A complete WAV file in memory. */
    fun wav(samples: ShortArray, from: Int = 0, to: Int = samples.size): ByteArray {
        val n = to - from
        val out = ByteArrayOutputStream(44 + n * 2)
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(36 + n * 2).put("WAVE".toByteArray())
        header.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
        header.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort(2).putShort(16)
        header.put("data".toByteArray()).putInt(n * 2)
        out.write(header.array())
        val body = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (i in from until to) body.putShort(samples[i])
        out.write(body.array())
        return out.toByteArray()
    }

    /** Reads a WAV file (16-bit PCM or 32-bit float). Stereo is mixed down; other rates are resampled linearly. */
    fun readWav(file: File): ShortArray {
        val bytes = file.readBytes()
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require(bytes.size > 44 && String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WAVE") { "not a WAV file" }
        var pos = 12
        var channels = 1
        var rate = SAMPLE_RATE
        var bits = 16
        var float = false
        var data: ShortArray? = null
        while (pos + 8 <= bytes.size) {
            val id = String(bytes, pos, 4)
            val size = buf.getInt(pos + 4)
            val body = pos + 8
            if (id == "fmt ") {
                val format = buf.getShort(body).toInt() and 0xFFFF
                channels = buf.getShort(body + 2).toInt()
                rate = buf.getInt(body + 4)
                bits = buf.getShort(body + 14).toInt()
                float = format == 3
                require((format == 1 && bits == 16) || (float && bits == 32)) { "only 16-bit PCM and 32-bit float WAV are supported" }
            } else if (id == "data") {
                val width = bits / 8
                val length = minOf(size, bytes.size - body)
                val frames = length / (width * channels)
                val mono = ShortArray(frames)
                for (f in 0 until frames) {
                    var sum = 0f
                    for (c in 0 until channels) {
                        val at = body + (f * channels + c) * width
                        sum += if (float) buf.getFloat(at) * 32767f else buf.getShort(at).toFloat()
                    }
                    mono[f] = (sum / channels).coerceIn(-32768f, 32767f).toInt().toShort()
                }
                data = mono
                break
            }
            pos = body + size + (size and 1)
        }
        val mono = requireNotNull(data) { "WAV file has no audio" }
        if (rate == SAMPLE_RATE) return mono
        val outLength = (mono.size.toLong() * SAMPLE_RATE / rate).toInt()
        return ShortArray(outLength) { i ->
            val at = i.toDouble() * rate / SAMPLE_RATE
            val a = at.toInt().coerceAtMost(mono.size - 1)
            val b = (a + 1).coerceAtMost(mono.size - 1)
            (mono[a] + (mono[b] - mono[a]) * (at - a)).toInt().toShort()
        }
    }

    /**
     * Cuts a recording into segments of at most [maxSamples], each cut placed in the quietest
     * half second of the last eight seconds, so a word is not split between two segments.
     */
    fun segments(samples: ShortArray, count: Int = samples.size, maxSamples: Int = MAX_SEGMENT_SAMPLES): List<IntRange> {
        val out = mutableListOf<IntRange>()
        var start = 0
        val window = SAMPLE_RATE / 2
        while (count - start > maxSamples) {
            val searchFrom = start + maxSamples - 8 * SAMPLE_RATE
            var best = start + maxSamples
            var bestEnergy = Double.MAX_VALUE
            var at = searchFrom
            while (at + window <= start + maxSamples) {
                var energy = 0.0
                for (i in at until at + window) energy += samples[i].toDouble() * samples[i]
                if (energy < bestEnergy) {
                    bestEnergy = energy
                    best = at + window / 2
                }
                at += window / 4
            }
            out.add(start until best)
            start = best
        }
        if (count > start) out.add(start until count)
        return out
    }
}
