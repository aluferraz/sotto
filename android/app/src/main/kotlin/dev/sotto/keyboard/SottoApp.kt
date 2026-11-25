package dev.sotto.keyboard

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import dev.sotto.core.Audio
import dev.sotto.core.CleanupLevel
import java.io.File

class SottoApp : Application() {
    lateinit var settings: SettingsStore
        private set
    lateinit var history: HistoryStore
        private set
    lateinit var models: ModelStore
        private set
    lateinit var engine: EngineHost
        private set

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        history = HistoryStore(this)
        models = ModelStore(this)
        engine = EngineHost(this, models, settings)
        if (BuildConfig.DEBUG) registerDebugHook()
    }

    /**
     * Debug builds only: feeds a WAV file through the same path as a recording, so the keyboard
     * can be tested without a voice.
     *
     *   adb shell am broadcast -a dev.sotto.keyboard.DEBUG_DICTATE --es path clip.wav
     *
     * The path is relative to the app's files directory. With the keyboard open the text is
     * typed into the field; otherwise it is only written to the log.
     */
    private fun registerDebugHook() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val file = File(filesDir, intent.getStringExtra("path") ?: return)
                val samples = runCatching { Audio.readWav(file) }.getOrElse {
                    Log.w("Sotto", "debug: cannot read $file", it)
                    return
                }
                val keyboard = SottoIme.instance
                if (keyboard != null && keyboard.isInputViewShown) {
                    keyboard.process(samples, samples.size)
                    return
                }
                val s = settings.data.value
                val request = EngineHost.Request(samples, samples.size, s.language, s.cleanup == CleanupLevel.SMART, s.spellingHints)
                engine.dictate(request, onPartial = {}) { result ->
                    Log.i("Sotto", "debug result: ${result.map { "raw=[${it.raw}] text=[${it.text}] asr=${it.asrMs}ms cleanup=${it.cleanupMs}ms ${it.note}" }}")
                }
            }
        }
        val filter = IntentFilter("dev.sotto.keyboard.DEBUG_DICTATE")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag") registerReceiver(receiver, filter)
        }
    }
}

val Context.sotto: SottoApp get() = applicationContext as SottoApp
