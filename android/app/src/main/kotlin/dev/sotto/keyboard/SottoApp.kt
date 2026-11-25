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
    lateinit var apiKey: ApiKeyVault
        private set

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        history = HistoryStore(this)
        models = ModelStore(this)
        apiKey = ApiKeyVault(this)
        engine = EngineHost(this, models, settings, apiKey)
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
     *
     * A second broadcast points the app at an OpenAI-compatible API (or back at the phone's own
     * model with `--ez off true`), and logs whether the key came back from the keystore intact:
     *
     *   adb shell am broadcast -a dev.sotto.keyboard.DEBUG_API --es url http://10.0.2.2:47631/v1 \
     *       --es model whisper-1 [--es cleanup_model NAME] [--es key SECRET]
     */
    private fun registerDebugHook() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == "dev.sotto.keyboard.DEBUG_API") {
                    val off = intent.getBooleanExtra("off", false)
                    settings.update {
                        it.copy(
                            useApi = !off,
                            apiBaseUrl = intent.getStringExtra("url") ?: it.apiBaseUrl,
                            apiModel = intent.getStringExtra("model") ?: it.apiModel,
                            apiCleanupModel = intent.getStringExtra("cleanup_model") ?: "",
                        )
                    }
                    intent.getStringExtra("key")?.let { apiKey.set(it) }
                    // A fresh vault reads the file back through the keystore, as after a restart.
                    val stored = ApiKeyVault(context).get()
                    Log.i("Sotto", "debug api: ${if (off) "off" else settings.data.value.apiBaseUrl}, key of ${stored.length} characters" +
                        intent.getStringExtra("key")?.let { " (${if (it == stored) "matches" else "DIFFERS from"} what was saved)" }.orEmpty())
                    return
                }
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
        val filter = IntentFilter("dev.sotto.keyboard.DEBUG_DICTATE").apply { addAction("dev.sotto.keyboard.DEBUG_API") }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag") registerReceiver(receiver, filter)
        }
    }
}

val Context.sotto: SottoApp get() = applicationContext as SottoApp
