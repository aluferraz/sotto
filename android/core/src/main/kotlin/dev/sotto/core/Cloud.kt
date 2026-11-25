package dev.sotto.core

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

/** Where an OpenAI-compatible API lives and what to ask it for. */
data class CloudConfig(
    /** The API's root, such as https://api.openai.com/v1. */
    val baseUrl: String,
    val apiKey: String,
    /** The transcription model's name at that API. */
    val model: String,
    /** A chat model for the Smart editing pass; empty to skip that pass. */
    val cleanupModel: String,
)

class CloudException(message: String) : Exception(message)

/**
 * Dictation through any service that speaks the OpenAI API, for those who prefer a hosted model
 * or whose phone cannot run the local one: `POST {base}/audio/transcriptions` for the speech and,
 * optionally, `POST {base}/chat/completions` for the Smart editing pass. The same guard as for
 * the local model decides whether the edited text can be trusted. Blocking; call off the main
 * thread.
 */
object Cloud {
    /** The codes these APIs expect, for the language names the settings use. */
    val languageCodes = mapOf(
        "English" to "en", "Arabic" to "ar", "Chinese" to "zh", "Danish" to "da", "Dutch" to "nl", "Finnish" to "fi",
        "French" to "fr", "German" to "de", "Greek" to "el", "Hebrew" to "he", "Italian" to "it", "Japanese" to "ja",
        "Korean" to "ko", "Polish" to "pl", "Portuguese" to "pt", "Spanish" to "es", "Swedish" to "sv", "Turkish" to "tr",
    )

    /** Empty when the configuration can be used; otherwise what is missing. */
    fun problem(config: CloudConfig): String {
        if (!Regex("^https?://\\S+$", RegexOption.IGNORE_CASE).matches(config.baseUrl.trim())) {
            return "Enter the API address, for example https://api.openai.com/v1."
        }
        if (config.model.isBlank()) return "Enter the name of the transcription model."
        return ""
    }

    fun dictate(
        config: CloudConfig,
        samples: ShortArray,
        count: Int,
        language: String,
        smart: Boolean,
        vocabulary: List<String>,
    ): SpeechEngine.Result {
        problem(config).let { if (it.isNotEmpty()) throw CloudException(it) }
        val started = System.nanoTime()
        val raw = transcribe(config, Audio.wav(samples, 0, count), language, vocabulary)
        val asrMs = (System.nanoTime() - started) / 1_000_000
        var text = raw
        var note = ""
        var cleanupMs = 0L
        val english = language.isBlank() || language == "English"
        if (smart && english && config.cleanupModel.isNotBlank() && Cleanup.words(raw).size >= 4) {
            val cleanupStarted = System.nanoTime()
            try {
                val answer = cleanup(config, raw, vocabulary)
                val why = Cleanup.rejection(raw, answer, vocabulary)
                if (why.isEmpty()) text = answer else note = "cleanup rejected ($why); used the raw transcript"
            } catch (e: Exception) {
                // The words are already here; losing the polish is better than losing the dictation.
                note = "cleanup failed (${e.message}); used the raw transcript"
            }
            cleanupMs = (System.nanoTime() - cleanupStarted) / 1_000_000
        }
        return SpeechEngine.Result(raw, text, count.toDouble() / Audio.SAMPLE_RATE, asrMs, cleanupMs, note)
    }

    fun transcribe(config: CloudConfig, wav: ByteArray, language: String, vocabulary: List<String>): String {
        val boundary = "sotto-${System.nanoTime()}"
        val body = ByteArrayOutputStream(wav.size + 1024)
        fun field(name: String, value: String) =
            body.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray())
        body.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n".toByteArray())
        body.write(wav)
        body.write("\r\n".toByteArray())
        field("model", config.model.trim())
        field("response_format", "json")
        languageCodes[language]?.let { field("language", it) }
        // The API's "prompt" is its way to be told how names are spelled.
        if (vocabulary.isNotEmpty()) field("prompt", vocabulary.take(100).joinToString(", "))
        body.write("--$boundary--\r\n".toByteArray())

        val answer = post(config, "/audio/transcriptions", "multipart/form-data; boundary=$boundary", body.toByteArray())
        // Some servers answer with the bare text whatever format was asked for.
        return runCatching { JSONObject(answer).getString("text") }.getOrDefault(answer).trim()
    }

    fun cleanup(config: CloudConfig, text: String, vocabulary: List<String>): String {
        val messages = JSONArray()
        fun message(role: String, content: String) = messages.put(JSONObject().put("role", role).put("content", content))
        message("system", Cleanup.system(vocabulary))
        for ((heard, written) in Cleanup.shots) {
            message("user", Cleanup.wrap(heard))
            message("assistant", written)
        }
        message("user", Cleanup.wrap(text))
        val payload = JSONObject().put("model", config.cleanupModel.trim()).put("messages", messages).put("temperature", 0)
        val answer = post(config, "/chat/completions", "application/json", payload.toString().toByteArray())
        val content = runCatching {
            JSONObject(answer).getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content")
        }.getOrNull() ?: throw CloudException("The API returned no text for the editing pass.")
        return Cleanup.unwrap(content)
    }

    private fun post(config: CloudConfig, path: String, contentType: String, body: ByteArray): String {
        val connection = try {
            URL(config.baseUrl.trim().trimEnd('/') + path).openConnection() as HttpURLConnection
        } catch (e: Exception) {
            throw CloudException(problem(config).ifEmpty { "The API address is not valid." })
        }
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 120_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", contentType)
            if (config.apiKey.isNotBlank()) connection.setRequestProperty("Authorization", "Bearer ${config.apiKey.trim()}")
            // Not sent in streaming mode: with it, Java refuses to hand over the body of a 401 answer.
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val answer = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            if (status !in 200..299) throw CloudException(failure(status, answer))
            return answer
        } catch (e: CloudException) {
            throw e
        } catch (e: Exception) {
            throw CloudException("The API could not be reached: ${e.message ?: e.javaClass.simpleName}")
        } finally {
            connection.disconnect()
        }
    }

    /** The API's own words for what went wrong, when it gave any. */
    fun failure(status: Int, body: String): String {
        var detail = body.trim().take(300)
        runCatching {
            val json = JSONObject(body)
            detail = json.optJSONObject("error")?.optString("message")?.takeIf { it.isNotEmpty() }
                ?: json.optString("message").takeIf { it.isNotEmpty() } ?: detail
        }
        return "The API answered $status" + if (detail.isEmpty()) "." else ": $detail"
    }
}
