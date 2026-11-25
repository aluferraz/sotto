package dev.sotto.keyboard

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import dev.sotto.core.CleanupLevel
import dev.sotto.core.Cloud
import dev.sotto.core.PostProcessor
import dev.sotto.core.SpeechEngine
import dev.sotto.core.SpeechGate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** The keyboard: records while the microphone is held or toggled, then types what was said. */
class SottoIme : InputMethodService(), KeyboardView.Listener {
    private val recorder = Recorder()
    private val main = Handler(Looper.getMainLooper())
    private var scope: CoroutineScope? = null
    private var view: KeyboardView? = null

    private var micDownAt = 0L
    private var pressStartedRecording = false

    /** Raised whenever a dictation is started or abandoned, so a late result is dropped. */
    private var generation = 0

    /** A short message that replaces the idle hint for a few seconds. */
    private var notice: String? = null
    private val clearNotice = Runnable {
        notice = null
        showStatus()
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        recorder.onLevel = { view?.pushLevel(it) }
        recorder.onLimit = { finishRecording() }
        scope = MainScope().also { scope ->
            scope.launch {
                combine(sotto.engine.state, sotto.models.state, sotto.settings.data) { _, _, _ -> }.collect { showStatus() }
            }
        }
    }

    override fun onDestroy() {
        instance = null
        scope?.cancel()
        recorder.stop()
        super.onDestroy()
    }

    override fun onCreateInputView(): View {
        // The view is rebuilt when the phone is turned; a recording in progress does not survive that.
        if (recorder.isRecording) recorder.stop()
        generation++
        val created = KeyboardView(this, this)
        created.panel = if (sotto.settings.data.value.openOnVoice) KeyboardView.Panel.VOICE else KeyboardView.Panel.LETTERS
        view = created
        showStatus()
        return created
    }

    override fun onEvaluateFullscreenMode() = false

    override fun onStartInputView(info: EditorInfo, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        sotto.models.refresh()
        sotto.engine.warm()
        view?.let {
            it.isHapticFeedbackEnabled = sotto.settings.data.value.haptics
            it.showGlobe = shouldOfferSwitchingToNextInputMethod()
            it.enterLabel = when (enterAction(info)) {
                EditorInfo.IME_ACTION_GO -> "Go"
                EditorInfo.IME_ACTION_SEARCH -> "Search"
                EditorInfo.IME_ACTION_SEND -> "Send"
                EditorInfo.IME_ACTION_NEXT -> "Next"
                EditorInfo.IME_ACTION_DONE -> "Done"
                else -> ""
            }
        }
        updateShift()
        showStatus()
    }

    override fun onFinishInputView(finishingInput: Boolean) {
        // A recording that loses its keyboard is thrown away, never typed somewhere unseen.
        if (recorder.isRecording) {
            recorder.stop()
            view?.phase = KeyboardView.Phase.IDLE
        }
        super.onFinishInputView(finishingInput)
    }

    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int, candidatesStart: Int, candidatesEnd: Int,
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        updateShift()
    }

    // Status

    private fun say(message: String) {
        notice = message
        main.removeCallbacks(clearNotice)
        main.postDelayed(clearNotice, 4000)
        showStatus()
    }

    private fun showStatus() {
        val view = view ?: return
        if (view.phase != KeyboardView.Phase.IDLE) return
        val problem = problem()
        view.statusIsProblem = problem != null
        view.status = problem ?: notice ?: if (sotto.settings.data.value.useApi) "Ready · using your API" else when (val state = sotto.engine.state.value) {
            EngineHost.State.Loading -> "Loading the speech model…"
            is EngineHost.State.Ready -> "Ready · on this phone's ${state.processor}"
            else -> "Sotto"
        }
    }

    /** Something only the app can fix; tapping the strip opens it. */
    private fun problem(): String? {
        val settings = sotto.settings.data.value
        if (settings.useApi) {
            // The key is not needed to tell whether the address and the model are filled in.
            if (Cloud.problem(settings.cloudConfig("")).isNotEmpty()) return "Tap here to finish setting up the API"
        } else if (!sotto.models.isReady) {
            return "Tap here to download the speech model"
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return "Tap here to allow the microphone"
        }
        if (!settings.useApi) {
            (sotto.engine.state.value as? EngineHost.State.Failed)?.let { return "The model did not load: ${it.message}" }
        }
        return null
    }

    // Dictation

    override fun onMicDown() {
        val view = view ?: return
        micDownAt = SystemClock.uptimeMillis()
        pressStartedRecording = false
        if (view.phase == KeyboardView.Phase.IDLE) {
            pressStartedRecording = startRecording()
        }
    }

    override fun onMicUp() {
        if (view?.phase != KeyboardView.Phase.RECORDING) return
        val held = SystemClock.uptimeMillis() - micDownAt
        // Held: talk while pressed. Tapped: keep listening until the next tap.
        if (!pressStartedRecording || held >= HOLD_MS) finishRecording()
    }

    override fun onMicTap() {
        when (view?.phase) {
            KeyboardView.Phase.IDLE -> startRecording()
            KeyboardView.Phase.RECORDING -> finishRecording()
            else -> {}
        }
    }

    override fun onCancel() {
        val view = view ?: return
        if (view.phase == KeyboardView.Phase.RECORDING) recorder.stop()
        generation++
        view.phase = KeyboardView.Phase.IDLE
        say("Discarded")
    }

    private fun startRecording(): Boolean {
        val view = view ?: return false
        if (problem() != null) {
            showStatus()
            return false
        }
        if (!recorder.start()) {
            say("The microphone is in use by another app")
            return false
        }
        generation++
        main.removeCallbacks(clearNotice)
        notice = null
        sotto.engine.warm()
        view.status = "Listening…"
        view.statusIsProblem = false
        view.phase = KeyboardView.Phase.RECORDING
        return true
    }

    private fun finishRecording() {
        val view = view ?: return
        if (view.phase != KeyboardView.Phase.RECORDING) return
        val (samples, count) = recorder.stop()
        view.phase = KeyboardView.Phase.IDLE
        // Silence never reaches the model: it would invent a sentence.
        if (!SpeechGate.containsSpeech(SpeechGate.frames(samples, count))) {
            say("Didn't hear anything")
            return
        }
        process(samples, count)
    }

    /** Recognizes [samples] and types the result. Also the entry point of the debug hook. */
    fun process(samples: ShortArray, count: Int) {
        val view = view ?: return
        val settings = sotto.settings.data.value
        val token = ++generation
        view.statusIsProblem = false
        view.status = "Transcribing…"
        view.phase = KeyboardView.Phase.PROCESSING
        val request = EngineHost.Request(
            samples, count, settings.language, settings.cleanup == CleanupLevel.SMART, settings.spellingHints,
        )
        sotto.engine.dictate(
            request,
            onPartial = { text -> if (token == generation) view.status = text },
        ) { result ->
            if (token != generation) return@dictate
            view.phase = KeyboardView.Phase.IDLE
            result.fold(
                onSuccess = { deliver(it, settings) },
                onFailure = { say(it.message ?: "Transcription failed") },
            )
        }
    }

    private fun deliver(result: SpeechEngine.Result, settings: SettingsData) {
        val info = currentInputEditorInfo
        val options = PostProcessor.Options(
            settings.cleanup, settings.toneFor(info?.packageName), settings.replacements, settings.snippets,
        )
        val text = PostProcessor.process(result.text, options)
        Log.i(TAG, "dictation: ${"%.1f".format(result.audioSeconds)} s audio, asr ${result.asrMs} ms, cleanup ${result.cleanupMs} ms ${result.note}")
        if (text.isEmpty()) {
            say("Nothing to type")
            return
        }
        val private = isPrivate(info)
        if (settings.keepHistory && !private) {
            sotto.history.add(HistoryEntry(System.currentTimeMillis(), text, result.raw, info?.packageName.orEmpty()))
        }
        val connection = currentInputConnection
        if (connection == null) {
            say(if (settings.keepHistory && !private) "No text field: saved in History" else "No text field to type into")
            return
        }
        val before = connection.getTextBeforeCursor(80, 0)?.toString()
        connection.commitText(PostProcessor.fit(text, before, settings.spellingHints), 1)
        say("Typed in %.1f s".format((result.asrMs + result.cleanupMs) / 1000.0))
        updateShift()
    }

    /** Password fields and fields that ask not to be learned from stay out of the history. */
    private fun isPrivate(info: EditorInfo?): Boolean {
        info ?: return false
        if (info.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING != 0) return true
        val variation = info.inputType and InputType.TYPE_MASK_VARIATION
        return when (info.inputType and InputType.TYPE_MASK_CLASS) {
            InputType.TYPE_CLASS_TEXT -> variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    // Keys

    override fun onText(text: String) {
        currentInputConnection?.commitText(text, 1)
        updateShift()
    }

    override fun onBackspace() {
        val connection = currentInputConnection ?: return
        if (!connection.getSelectedText(0).isNullOrEmpty()) {
            connection.commitText("", 1)
        } else {
            sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
        }
    }

    private fun enterAction(info: EditorInfo?): Int {
        info ?: return EditorInfo.IME_ACTION_NONE
        if (info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0) return EditorInfo.IME_ACTION_NONE
        return info.imeOptions and EditorInfo.IME_MASK_ACTION
    }

    override fun onEnter() {
        val action = enterAction(currentInputEditorInfo)
        when (action) {
            EditorInfo.IME_ACTION_GO, EditorInfo.IME_ACTION_SEARCH, EditorInfo.IME_ACTION_SEND,
            EditorInfo.IME_ACTION_NEXT, EditorInfo.IME_ACTION_DONE -> currentInputConnection?.performEditorAction(action)
            else -> sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
        }
    }

    override fun onSwitchKeyboard() {
        if (!switchToNextInputMethod(false)) {
            getSystemService(InputMethodManager::class.java).showInputMethodPicker()
        }
    }

    override fun onOpenApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun updateShift() {
        val info = currentInputEditorInfo ?: return
        if (info.inputType == InputType.TYPE_NULL) return
        val caps = currentInputConnection?.getCursorCapsMode(info.inputType) ?: 0
        view?.setAutoShift(caps != 0)
    }

    companion object {
        private const val TAG = "Sotto"
        private const val HOLD_MS = 400

        /** The running keyboard, for the debug hook. */
        @Volatile var instance: SottoIme? = null
            private set
    }
}
