package dev.sotto.keyboard

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import dev.sotto.core.Audio
import dev.sotto.core.SpeechGate
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/** Captures the microphone as 16 kHz mono 16-bit samples and reports loudness for the waveform. */
class Recorder {
    /** Called on the main thread about 25 times a second with a level from 0 to 1. */
    var onLevel: ((Float) -> Unit)? = null

    /** Called on the main thread when the recording reaches [MAX_SECONDS]. */
    var onLimit: (() -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    private var samples = ShortArray(Audio.SAMPLE_RATE * 30)
    @Volatile private var count = 0

    val isRecording get() = running

    val seconds get() = count.toDouble() / Audio.SAMPLE_RATE

    /** False when the microphone could not be opened (no permission, or another app holds it). */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        val minimum = AudioRecord.getMinBufferSize(
            Audio.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) return false
        val created = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                Audio.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                max(minimum, Audio.SAMPLE_RATE), // half a second of room
            )
        } catch (e: Exception) {
            return false
        }
        if (created.state != AudioRecord.STATE_INITIALIZED) {
            created.release()
            return false
        }
        try {
            created.startRecording()
        } catch (e: Exception) {
            created.release()
            return false
        }
        if (created.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            created.release()
            return false
        }
        record = created
        count = 0
        running = true
        thread = Thread({ pump(created) }, "sotto-recorder").also { it.start() }
        return true
    }

    private fun pump(record: AudioRecord) {
        val frame = ShortArray(SpeechGate.FRAME)
        var sinceReport = 0
        var peak = 0f
        while (running) {
            val n = record.read(frame, 0, frame.size)
            if (n <= 0) break
            if (count + n > samples.size) {
                if (count + n > MAX_SECONDS * Audio.SAMPLE_RATE) {
                    main.post { onLimit?.invoke() }
                    break
                }
                samples = samples.copyOf(samples.size * 2)
            }
            System.arraycopy(frame, 0, samples, count, n)
            count += n

            var sum = 0.0
            for (i in 0 until n) {
                val v = frame[i] / 32768.0
                sum += v * v
            }
            // -50 dBFS and below draws nothing; -10 dBFS fills the bar.
            val db = 20 * log10(max(sqrt(sum / n), 1e-6))
            peak = max(peak, ((db + 50) / 40).toFloat().coerceIn(0f, 1f))
            sinceReport += n
            if (sinceReport >= Audio.SAMPLE_RATE / 25) {
                val level = peak
                main.post { if (running) onLevel?.invoke(level) }
                sinceReport = 0
                peak = 0f
            }
        }
    }

    /** Stops and returns the samples with their count. The array may be longer than the count. */
    fun stop(): Pair<ShortArray, Int> {
        running = false
        val record = record
        this.record = null
        runCatching { record?.stop() }
        runCatching { thread?.join(1000) }
        thread = null
        runCatching { record?.release() }
        return samples to count
    }

    companion object {
        const val MAX_SECONDS = 300
    }
}
