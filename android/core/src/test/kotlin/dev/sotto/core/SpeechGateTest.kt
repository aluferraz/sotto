package dev.sotto.core

import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechGateTest {
    @Test fun digitalSilenceIsNotSpeech() = assertFalse(SpeechGate.containsSpeech(FloatArray(200)))

    @Test fun steadyRoomNoiseIsNotSpeech() {
        val noise = FloatArray(200) { (0.008 + 0.001 * sin(it.toDouble())).toFloat() }
        assertFalse(SpeechGate.containsSpeech(noise))
    }

    @Test fun normalSpeechIsSpeechEvenWithoutPauses() = assertTrue(SpeechGate.containsSpeech(FloatArray(40) { 0.08f }))

    @Test fun whisperOverQuietRoomIsSpeech() {
        val frames = FloatArray(100) { if (it in 30 until 70) 0.006f else 0.0008f }
        assertTrue(SpeechGate.containsSpeech(frames))
    }

    @Test fun tooShortIsNotSpeech() = assertFalse(SpeechGate.containsSpeech(floatArrayOf(0.5f, 0.5f)))

    @Test fun keyTapsInAQuietRoomAreNotSpeech() {
        // Two sharp clicks of 40 ms each over a -52 dBFS room.
        val frames = FloatArray(150) { if (it in listOf(3, 4, 140, 141)) 0.03f else 0.0025f }
        assertFalse(SpeechGate.containsSpeech(frames))
    }

    @Test fun oneShortWordIsSpeech() {
        val frames = FloatArray(60) { if (it in 20 until 32) 0.04f else 0.002f } // "yes": 240 ms
        assertTrue(SpeechGate.containsSpeech(frames))
    }

    @Test fun framesComputeRmsPerWindow() {
        val samples = ShortArray(740) { if (it < 320) 16384 else if (it < 640) 0 else 32767 }
        val frames = SpeechGate.frames(samples)
        assertEquals(2, frames.size)
        assertEquals(0.5f, frames[0], 1e-4f)
        assertEquals(0f, frames[1], 1e-6f)
    }
}
