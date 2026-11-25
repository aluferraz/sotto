package dev.sotto.core

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import java.util.concurrent.CountDownLatch

/**
 * LFM3-Audio on LiteRT-LM: speech to text, and the optional second pass that cleans the text.
 * One instance holds the loaded model; calls must come from one thread at a time.
 *
 * The same class runs on a phone (litertlm-android) and on a desktop JVM (litertlm-jvm).
 */
class SpeechEngine(
    private val modelPath: String,
    /** Run the language model on the GPU. The audio encoder follows unless [audioOnCpu] is set. */
    val gpu: Boolean,
    private val audioOnCpu: Boolean = false,
    private val cacheDir: String? = null,
) : AutoCloseable {

    data class Result(
        val raw: String,
        val text: String,
        val audioSeconds: Double,
        val asrMs: Long,
        val cleanupMs: Long,
        /** Why the cleaned text was not used, when it was not. */
        val note: String,
    )

    private var engine: Engine? = null

    /**
     * A conversation that has already read the cleanup instructions and examples, waiting for
     * one transcript. It is used once: copies made with `Conversation.clone()` gave answers
     * that drifted from one request to the next with this model.
     */
    private var prepared: Conversation? = null
    private var preparedVocabulary: List<String>? = null

    val isLoaded get() = engine != null

    /** Loads the model. Slow (seconds); call it off the main thread. */
    fun load() {
        if (engine != null) return
        val main: Backend = if (gpu) Backend.GPU() else Backend.CPU()
        val audio: Backend = if (gpu && !audioOnCpu) Backend.GPU() else Backend.CPU()
        val created = Engine(EngineConfig(modelPath = modelPath, backend = main, audioBackend = audio, cacheDir = cacheDir))
        created.initialize()
        engine = created
    }

    override fun close() {
        runCatching { prepared?.close() }
        prepared = null
        preparedVocabulary = null
        runCatching { engine?.close() }
        engine = null
    }

    /**
     * Speech to text. [language] is an English language name ("English", "French") or empty to
     * let the model decide. A recording longer than one model window is cut at pauses and the
     * pieces are transcribed in turn; [onPartial] receives the text so far as it grows.
     */
    fun transcribe(samples: ShortArray, count: Int, language: String, onPartial: ((String) -> Unit)? = null): String {
        val engine = checkNotNull(engine) { "the model is not loaded" }
        val system = if (language.isBlank()) "Perform ASR." else "Perform ASR in $language."
        val done = StringBuilder()
        for (range in Audio.segments(samples, count)) {
            val seconds = (range.last - range.first + 1).toDouble() / Audio.SAMPLE_RATE
            // Speech rarely exceeds 5 tokens per second; leave generous headroom.
            val budget = (seconds * 12).toInt().coerceIn(96, 512)
            val config = ConversationConfig(systemInstruction = Contents.of(system), maxOutputToken = budget)
            val wav = Audio.wav(samples, range.first, range.last + 1)
            val prefix = if (done.isEmpty()) "" else "$done "
            val piece = engine.createConversation(config).use { conversation ->
                send(conversation, Contents.of(Content.AudioBytes(wav)), onPartial?.let { report -> { report(prefix + it) } })
            }
            if (piece.isNotEmpty()) {
                if (done.isNotEmpty()) done.append(' ')
                done.append(piece)
            }
        }
        return done.toString()
    }

    /**
     * Reads the cleanup instructions ahead of time, so the next [cleanup] only has to read the
     * transcript. Worth calling while nothing else is waiting; it takes as long as a cleanup.
     */
    fun prepareCleanup(vocabulary: List<String>) {
        val engine = engine ?: return
        if (prepared != null && preparedVocabulary == vocabulary) return
        runCatching { prepared?.close() }
        val messages = Cleanup.shots.flatMap { (heard, written) ->
            listOf(Message.user(Cleanup.wrap(heard)), Message.model(written))
        }
        prepared = engine.createConversation(
            ConversationConfig(
                systemInstruction = Contents.of(Cleanup.system(vocabulary)),
                initialMessages = messages,
                prefillPrefaceOnInit = true,
            )
        )
        preparedVocabulary = vocabulary
    }

    /** The second pass. Returns the model's answer as it is; [Cleanup.rejection] judges it. */
    fun cleanup(text: String, vocabulary: List<String>): String {
        checkNotNull(engine) { "the model is not loaded" }
        prepareCleanup(vocabulary)
        val conversation = prepared!!
        prepared = null
        val budget = (text.length / 2.5).toInt() + 48
        return conversation.use {
            Cleanup.unwrap(it.sendMessage(Cleanup.wrap(text), maxOutputToken = budget).toString())
        }
    }

    /**
     * The whole pipeline for one recording: recognize, then clean when [smart] is set, the
     * language is English and there is enough text for cleaning to matter.
     */
    fun dictate(
        samples: ShortArray,
        count: Int,
        language: String,
        smart: Boolean,
        vocabulary: List<String>,
        onPartial: ((String) -> Unit)? = null,
    ): Result {
        val started = System.nanoTime()
        val raw = transcribe(samples, count, language, onPartial).trim()
        val asrMs = (System.nanoTime() - started) / 1_000_000
        var text = raw
        var note = ""
        var cleanupMs = 0L
        // The cleanup examples are English; in other languages the model tends to translate,
        // so those keep the transcript as recognized.
        val english = language.isBlank() || language == "English"
        if (smart && english && Cleanup.words(raw).size >= 4) {
            val cleanupStarted = System.nanoTime()
            val cleaned = Cleanup.pieces(raw).map { piece ->
                val answer = cleanup(piece, vocabulary)
                val why = Cleanup.rejection(piece, answer, vocabulary)
                if (why.isEmpty()) answer else piece.also { note = "cleanup rejected ($why); used the raw transcript" }
            }
            text = cleaned.joinToString(" ")
            cleanupMs = (System.nanoTime() - cleanupStarted) / 1_000_000
        }
        return Result(raw, text, count.toDouble() / Audio.SAMPLE_RATE, asrMs, cleanupMs, note)
    }

    private fun send(conversation: Conversation, contents: Contents, onText: ((String) -> Unit)?): String {
        if (onText == null) return conversation.sendMessage(contents).toString().trim()
        val finished = CountDownLatch(1)
        val text = StringBuilder()
        var failure: Throwable? = null
        conversation.sendMessageAsync(
            contents,
            object : MessageCallback {
                override fun onMessage(message: Message) {
                    val piece = message.toString()
                    if (piece.isNotEmpty()) {
                        text.append(piece)
                        onText(text.toString())
                    }
                }

                override fun onDone() = finished.countDown()

                override fun onError(throwable: Throwable) {
                    failure = throwable
                    finished.countDown()
                }
            },
        )
        finished.await()
        failure?.let { throw it }
        return text.toString().trim()
    }
}
