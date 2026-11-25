package dev.sotto.keyboard

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.sotto.core.CleanupLevel
import dev.sotto.core.SpeechEngine
import java.io.File
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Owns the loaded model. Everything that touches it runs on one background thread; results
 * come back on the main thread. The model is loaded when the keyboard appears and unloaded
 * after a few idle minutes, because it holds well over a gigabyte of memory.
 */
class EngineHost(private val context: Context, private val models: ModelStore, private val settings: SettingsStore) {
    sealed interface State {
        data object Unloaded : State
        data object Loading : State
        /** [processor] is "GPU" or "CPU"; [note] says so when that is not what was asked for. */
        data class Ready(val processor: String, val loadMs: Long, val note: String = "") : State
        data class Failed(val message: String) : State
    }

    private val flow = MutableStateFlow<State>(State.Unloaded)
    val state: StateFlow<State> = flow

    private val worker = Executors.newSingleThreadExecutor { Thread(it, "sotto-engine") }
    private val main = Handler(Looper.getMainLooper())
    private var engine: SpeechEngine? = null
    private var loadedWithGpu = false
    private val unload = Runnable { unloadNow() }

    /** Left behind when a GPU load takes the whole process down, which cannot be caught. */
    private val gpuMarker = File(context.filesDir, "gpu-load-in-progress")

    /** True when the last attempt to load on the GPU crashed the app; the CPU is used instead. */
    val gpuCrashed get() = gpuMarker.exists()

    fun forgetGpuCrash() {
        gpuMarker.delete()
    }

    /** Starts loading the model if it is not loaded. Safe to call often. */
    fun warm() {
        scheduleUnload()
        if (!models.isReady) return
        val wantGpu = settings.data.value.useGpu && !gpuCrashed
        worker.execute {
            if (engine != null && loadedWithGpu == wantGpu) return@execute
            load(wantGpu)
        }
    }

    private fun load(wantGpu: Boolean) {
        engine?.close()
        engine = null
        flow.value = State.Loading
        val started = System.nanoTime()
        // The GPU for everything, then the GPU with the audio encoder on the CPU, then the CPU.
        val attempts = if (wantGpu) listOf(true to false, true to true, false to false) else listOf(false to false)
        var lastError: Throwable? = null
        for ((gpu, audioOnCpu) in attempts) {
            val candidate = SpeechEngine(models.file.path, gpu = gpu, audioOnCpu = audioOnCpu, cacheDir = context.cacheDir.path)
            try {
                if (gpu) gpuMarker.writeText("loading")
                candidate.load()
                if (gpu) gpuMarker.delete()
                engine = candidate
                loadedWithGpu = wantGpu
                val note = when {
                    !gpu && wantGpu -> "The GPU could not load the model, so it runs on the CPU, which is slower."
                    gpu && audioOnCpu -> "The audio encoder runs on the CPU."
                    else -> ""
                }
                val ms = (System.nanoTime() - started) / 1_000_000
                Log.i(TAG, "model loaded on ${if (gpu) "GPU" else "CPU"} in $ms ms. $note")
                flow.value = State.Ready(if (gpu) "GPU" else "CPU", ms, note)
                prepareCleanup()
                return
            } catch (e: Throwable) {
                if (gpu) gpuMarker.delete()
                Log.w(TAG, "load failed (gpu=$gpu audioOnCpu=$audioOnCpu)", e)
                lastError = e
                runCatching { candidate.close() }
            }
        }
        flow.value = State.Failed(lastError?.message ?: "The model could not be loaded.")
    }

    data class Request(
        val samples: ShortArray,
        val count: Int,
        val language: String,
        val smart: Boolean,
        val vocabulary: List<String>,
    )

    /** Recognizes one recording. Both callbacks arrive on the main thread. */
    fun dictate(request: Request, onPartial: (String) -> Unit, onDone: (Result<SpeechEngine.Result>) -> Unit) {
        main.removeCallbacks(unload)
        warm()
        worker.execute {
            val result = runCatching {
                val loaded = engine ?: error(
                    (flow.value as? State.Failed)?.message ?: "The model is not downloaded yet. Open Sotto to get it."
                )
                loaded.dictate(request.samples, request.count, request.language, request.smart, request.vocabulary) { text ->
                    main.post { onPartial(text) }
                }
            }
            result.exceptionOrNull()?.let { Log.w(TAG, "dictation failed", it) }
            main.post {
                scheduleUnload()
                onDone(result)
            }
            prepareCleanup()
        }
    }

    /**
     * On the worker thread, while nobody is waiting: has the model read the cleanup instructions
     * for the next dictation, which otherwise costs as much again as the cleanup itself.
     */
    private fun prepareCleanup() {
        val s = settings.data.value
        val english = s.language.isBlank() || s.language == "English"
        if (s.cleanup != CleanupLevel.SMART || !english) return
        runCatching { engine?.prepareCleanup(s.spellingHints) }.onFailure { Log.w(TAG, "could not prepare the cleanup pass", it) }
    }

    private fun scheduleUnload() {
        main.removeCallbacks(unload)
        val minutes = settings.data.value.unloadAfterMinutes
        if (minutes > 0) main.postDelayed(unload, minutes * 60_000L)
    }

    fun unloadNow() {
        main.removeCallbacks(unload)
        worker.execute {
            engine?.close()
            engine = null
            if (flow.value !is State.Failed) flow.value = State.Unloaded
        }
    }

    private companion object {
        const val TAG = "Sotto"
    }
}
