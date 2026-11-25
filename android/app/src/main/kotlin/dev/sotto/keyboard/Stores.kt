package dev.sotto.keyboard

import android.content.Context
import dev.sotto.core.CleanupLevel
import dev.sotto.core.CloudConfig
import dev.sotto.core.Replacement
import dev.sotto.core.Snippet
import dev.sotto.core.Tone
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

data class SettingsData(
    /** An English language name the model knows, or empty to let it decide. */
    val language: String = "English",
    val cleanup: CleanupLevel = CleanupLevel.SMART,
    val tone: Tone = Tone.FORMAL,
    /** Use the casual tone in chat apps whatever [tone] says. */
    val casualInChatApps: Boolean = true,
    val vocabulary: List<String> = emptyList(),
    val replacements: List<Replacement> = emptyList(),
    val snippets: List<Snippet> = emptyList(),
    val useGpu: Boolean = true,
    val haptics: Boolean = true,
    val keepHistory: Boolean = true,
    /** Minutes without dictation after which the model is unloaded to give its memory back. */
    val unloadAfterMinutes: Int = 5,
    /** Open on the large microphone instead of the letters. */
    val openOnVoice: Boolean = true,
    /** Send recordings to an OpenAI-compatible API instead of using the model on the phone. */
    val useApi: Boolean = false,
    /** The API's root. Its key is not kept here but in [ApiKeyVault]. */
    val apiBaseUrl: String = "https://api.openai.com/v1",
    val apiModel: String = "gpt-4o-mini-transcribe",
    /** A chat model for the Smart pass through the API; empty to skip that pass. */
    val apiCleanupModel: String = "",
) {
    fun cloudConfig(apiKey: String) = CloudConfig(apiBaseUrl, apiKey, apiModel, apiCleanupModel)

    /** Terms the cleanup pass should spell exactly: the dictionary plus the written side of every replacement. */
    val spellingHints: List<String>
        get() {
            val seen = HashSet<String>()
            return (vocabulary + replacements.map { it.written })
                .map { it.trim() }
                .filter { it.isNotEmpty() && seen.add(it.lowercase()) }
        }

    fun toneFor(packageName: String?): Tone =
        if (casualInChatApps && tone == Tone.FORMAL && packageName in chatApps) Tone.CASUAL else tone

    fun toJson(): JSONObject = JSONObject().apply {
        put("language", language)
        put("cleanup", cleanup.name)
        put("tone", tone.name)
        put("casualInChatApps", casualInChatApps)
        put("vocabulary", JSONArray(vocabulary))
        put("replacements", JSONArray(replacements.map { JSONObject().put("heard", it.heard).put("written", it.written) }))
        put("snippets", JSONArray(snippets.map { JSONObject().put("trigger", it.trigger).put("expansion", it.expansion) }))
        put("useGpu", useGpu)
        put("haptics", haptics)
        put("keepHistory", keepHistory)
        put("unloadAfterMinutes", unloadAfterMinutes)
        put("openOnVoice", openOnVoice)
        put("useApi", useApi)
        put("apiBaseUrl", apiBaseUrl)
        put("apiModel", apiModel)
        put("apiCleanupModel", apiCleanupModel)
    }

    companion object {
        val languages = listOf(
            "", "English", "Arabic", "Chinese", "Danish", "Dutch", "Finnish", "French", "German", "Greek",
            "Hebrew", "Italian", "Japanese", "Korean", "Polish", "Portuguese", "Spanish", "Swedish", "Turkish",
        )

        val chatApps = setOf(
            "com.whatsapp", "org.telegram.messenger", "com.google.android.apps.messaging", "com.discord",
            "com.Slack", "com.facebook.orca", "org.thoughtcrime.securesms", "com.samsung.android.messaging",
        )

        /** Field by field, so a file written by an older build still loads. */
        fun fromJson(json: JSONObject): SettingsData {
            val d = SettingsData()
            fun <T> list(key: String, read: (JSONArray, Int) -> T?): List<T>? {
                val array = json.optJSONArray(key) ?: return null
                return (0 until array.length()).mapNotNull { read(array, it) }
            }
            return SettingsData(
                language = json.optString("language", d.language),
                cleanup = runCatching { CleanupLevel.valueOf(json.getString("cleanup")) }.getOrDefault(d.cleanup),
                tone = runCatching { Tone.valueOf(json.getString("tone")) }.getOrDefault(d.tone),
                casualInChatApps = json.optBoolean("casualInChatApps", d.casualInChatApps),
                vocabulary = list("vocabulary") { a, i -> a.optString(i).takeIf { it.isNotBlank() } } ?: d.vocabulary,
                replacements = list("replacements") { a, i ->
                    a.optJSONObject(i)?.let { Replacement(it.optString("heard"), it.optString("written")) }
                } ?: d.replacements,
                snippets = list("snippets") { a, i ->
                    a.optJSONObject(i)?.let { Snippet(it.optString("trigger"), it.optString("expansion")) }
                } ?: d.snippets,
                useGpu = json.optBoolean("useGpu", d.useGpu),
                haptics = json.optBoolean("haptics", d.haptics),
                keepHistory = json.optBoolean("keepHistory", d.keepHistory),
                unloadAfterMinutes = json.optInt("unloadAfterMinutes", d.unloadAfterMinutes),
                openOnVoice = json.optBoolean("openOnVoice", d.openOnVoice),
                useApi = json.optBoolean("useApi", d.useApi),
                apiBaseUrl = json.optString("apiBaseUrl", d.apiBaseUrl),
                apiModel = json.optString("apiModel", d.apiModel),
                apiCleanupModel = json.optString("apiCleanupModel", d.apiCleanupModel),
            )
        }
    }
}

class SettingsStore(context: Context) {
    private val file = File(context.filesDir, "settings.json")
    private val flow = MutableStateFlow(load())
    val data: StateFlow<SettingsData> = flow

    private fun load(): SettingsData =
        runCatching { SettingsData.fromJson(JSONObject(file.readText())) }.getOrDefault(SettingsData())

    fun update(change: (SettingsData) -> SettingsData) {
        val next = change(flow.value)
        if (next == flow.value) return
        flow.value = next
        runCatching { file.writeText(next.toJson().toString(2)) }
    }
}

data class HistoryEntry(val time: Long, val text: String, val raw: String, val app: String)

class HistoryStore(context: Context) {
    private val file = File(context.filesDir, "history.json")
    private val flow = MutableStateFlow(load())
    val entries: StateFlow<List<HistoryEntry>> = flow

    private fun load(): List<HistoryEntry> = runCatching {
        val array = JSONArray(file.readText())
        (0 until array.length()).map {
            val o = array.getJSONObject(it)
            HistoryEntry(o.getLong("time"), o.getString("text"), o.optString("raw"), o.optString("app"))
        }
    }.getOrDefault(emptyList())

    fun add(entry: HistoryEntry) = save((listOf(entry) + flow.value).take(LIMIT))

    fun clear() = save(emptyList())

    private fun save(entries: List<HistoryEntry>) {
        flow.value = entries
        runCatching {
            file.writeText(JSONArray(entries.map {
                JSONObject().put("time", it.time).put("text", it.text).put("raw", it.raw).put("app", it.app)
            }).toString())
        }
    }

    private companion object {
        const val LIMIT = 200
    }
}
