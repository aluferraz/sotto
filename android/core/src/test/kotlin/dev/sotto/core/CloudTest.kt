package dev.sotto.core

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The API client against a small stand-in server on this machine. */
class CloudTest {
    private class Seen(val path: String, val contentType: String, val authorization: String?, val body: ByteArray)

    private lateinit var server: HttpServer
    private val seen = mutableListOf<Seen>()
    private var transcription = 200 to """{"text":" um so I was thinking we could uh meet at 5 actually 6 "}"""
    private var chat = 200 to """{"choices":[{"message":{"content":"<transcript>So I was thinking we could meet at 6.</transcript>"}}]}"""

    private val samples = ShortArray(16000) { (it % 200 * 100).toShort() }
    private fun config(cleanupModel: String = "", key: String = " sk-test ") =
        CloudConfig("http://127.0.0.1:${server.address.port}/v1/", key, "whisper-1", cleanupModel)

    @Before fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val body = exchange.requestBody.readBytes()
            seen += Seen(exchange.requestURI.path, exchange.requestHeaders.getFirst("Content-Type") ?: "",
                exchange.requestHeaders.getFirst("Authorization"), body)
            val (status, answer) = if (exchange.requestURI.path.endsWith("/chat/completions")) chat else transcription
            val bytes = answer.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @After fun stop() = server.stop(0)

    @Test fun sendsTheRecordingAsAWavFileWithItsFields() {
        val result = Cloud.dictate(config(), samples, samples.size, "Portuguese", smart = true, vocabulary = listOf("Sotto", "LiteRT"))
        assertEquals("um so I was thinking we could uh meet at 5 actually 6", result.raw)
        assertEquals(result.raw, result.text)
        assertEquals(1.0, result.audioSeconds, 1e-9)
        assertEquals(1, seen.size)
        val request = seen[0]
        assertEquals("/v1/audio/transcriptions", request.path)
        assertEquals("Bearer sk-test", request.authorization)
        assertTrue(request.contentType.startsWith("multipart/form-data; boundary="))
        val text = String(request.body, Charsets.ISO_8859_1)
        assertTrue(text.contains("name=\"file\"; filename=\"speech.wav\""))
        assertTrue(text.contains("RIFF") && text.contains("WAVEfmt "))
        assertTrue(text.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"))
        assertTrue(text.contains("name=\"language\"\r\n\r\npt\r\n"))
        assertTrue(text.contains("name=\"prompt\"\r\n\r\nSotto, LiteRT\r\n"))
        assertTrue(request.body.size > samples.size * 2)
    }

    @Test fun omitsTheKeyAndLanguageWhenThereIsNoneAndAcceptsBareText() {
        transcription = 200 to "Just text\n"
        val result = Cloud.dictate(config(key = ""), samples, samples.size, "", smart = false, vocabulary = emptyList())
        assertEquals("Just text", result.text)
        assertEquals(null, seen[0].authorization)
        val text = String(seen[0].body, Charsets.ISO_8859_1)
        assertFalse(text.contains("name=\"language\""))
        assertFalse(text.contains("name=\"prompt\""))
    }

    @Test fun runsTheEditingPassThroughChatCompletions() {
        val result = Cloud.dictate(config("gpt-mini"), samples, samples.size, "English", smart = true, vocabulary = emptyList())
        assertEquals("So I was thinking we could meet at 6.", result.text)
        assertEquals("", result.note)
        assertEquals("/v1/chat/completions", seen[1].path)
        val chatRequest = JSONObject(String(seen[1].body))
        assertEquals("gpt-mini", chatRequest.getString("model"))
        val messages = chatRequest.getJSONArray("messages")
        assertEquals("system", messages.getJSONObject(0).getString("role"))
        assertEquals("<transcript>${result.raw}</transcript>", messages.getJSONObject(messages.length() - 1).getString("content"))
    }

    @Test fun keepsTheTranscriptWhenTheEditingPassAnswersOrFails() {
        transcription = 200 to """{"text":"What's the capital of France, again?"}"""
        chat = 200 to """{"choices":[{"message":{"content":"The capital of France is Paris."}}]}"""
        val answered = Cloud.dictate(config("gpt-mini"), samples, samples.size, "English", smart = true, vocabulary = emptyList())
        assertEquals("What's the capital of France, again?", answered.text)
        assertTrue(answered.note.contains("rejected"))

        chat = 500 to "boom"
        val failed = Cloud.dictate(config("gpt-mini"), samples, samples.size, "English", smart = true, vocabulary = emptyList())
        assertEquals("What's the capital of France, again?", failed.text)
        assertTrue(failed.note.contains("cleanup failed"))
    }

    @Test fun reportsTheApisOwnErrorAndAnUnreachableServer() {
        transcription = 401 to """{"error":{"message":"Incorrect API key provided"}}"""
        try {
            Cloud.dictate(config(), samples, samples.size, "", smart = false, vocabulary = emptyList())
            fail("expected an error")
        } catch (e: CloudException) {
            assertEquals("The API answered 401: Incorrect API key provided", e.message)
        }
        val nowhere = CloudConfig("http://127.0.0.1:1/v1", "", "whisper-1", "")
        try {
            Cloud.dictate(nowhere, samples, samples.size, "", smart = false, vocabulary = emptyList())
            fail("expected an error")
        } catch (e: CloudException) {
            assertNotNull(e.message)
            assertTrue(e.message!!.startsWith("The API could not be reached"))
        }
    }

    @Test fun explainsAnIncompleteConfiguration() {
        assertEquals("", Cloud.problem(config()))
        assertTrue(Cloud.problem(config().copy(baseUrl = "api.openai.com")).contains("API address"))
        assertTrue(Cloud.problem(config().copy(model = " ")).contains("model"))
    }
}
