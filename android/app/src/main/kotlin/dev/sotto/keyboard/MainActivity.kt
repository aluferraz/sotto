package dev.sotto.keyboard

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateUtils
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.sotto.core.CleanupLevel
import dev.sotto.core.Cloud
import dev.sotto.core.Replacement
import dev.sotto.core.Snippet
import dev.sotto.core.Tone
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { SottoTheme { Surface(Modifier.fillMaxSize()) { Screen() } } }
    }

    override fun onResume() {
        super.onResume()
        sotto.models.refresh()
    }
}

@Composable
private fun SottoTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val colors = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        dark -> darkColorScheme()
        else -> lightColorScheme()
    }
    MaterialTheme(colorScheme = colors, content = content)
}

private val tabs = listOf("Setup", "Settings", "Dictionary", "History")

@Composable
private fun Screen() {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
        Text(
            "Sotto",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 20.dp, top = 12.dp),
        )
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            tabs.forEachIndexed { index, name ->
                FilterChip(selected = tab == index, onClick = { tab = index }, label = { Text(name) })
            }
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when (tab) {
                0 -> SetupTab()
                1 -> SettingsTab()
                2 -> DictionaryTab()
                else -> HistoryTab()
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

// Setup

@Composable
private fun SetupTab() {
    val context = LocalContext.current
    val app = context.sotto
    val model by app.models.state.collectAsState()
    val engine by app.engine.state.collectAsState()
    val settings by app.settings.data.collectAsState()

    // The other three steps change outside the app, so look again every second.
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            tick++
        }
    }
    val microphone = remember(tick) {
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }
    val imm = context.getSystemService(InputMethodManager::class.java)
    // Asked through InputMethodManager: newer Android versions refuse apps the settings keys.
    val enabled = remember(tick) { imm.enabledInputMethodList.any { it.packageName == context.packageName } }
    val selected = remember(tick) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            imm.currentInputMethodInfo?.packageName == context.packageName
        } else {
            runCatching {
                Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
            }.getOrNull()?.startsWith(context.packageName + "/") == true
        }
    }
    val askMicrophone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { tick++ }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        ModelDownloadService.start(context)
    }

    Text(
        if (settings.useApi) "Speech is turned into text by the API you chose in Settings. Your recordings are sent there."
        else "Speech is turned into text on this phone. After the model is downloaded, nothing you say or type leaves it.",
        style = MaterialTheme.typography.bodyMedium,
    )

    if (settings.useApi) {
        val problem = Cloud.problem(settings.cloudConfig(""))
        Step(1, "Speech engine: your API", done = problem.isEmpty()) {
            Text(
                if (problem.isEmpty()) "${settings.apiModel} at ${settings.apiBaseUrl.substringAfter("://").substringBefore('/')}"
                else "$problem It is on the Settings tab.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    } else Step(1, "Download the speech model", done = model is ModelStore.State.Ready) {
        when (val m = model) {
            is ModelStore.State.Absent -> {
                Text(
                    if (m.partial > 0) "Paused at ${m.partial / 1_000_000} of ${ModelStore.SIZE / 1_000_000} MB."
                    else "LFM3-Audio 2B, 1.5 GB. Use Wi-Fi.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(onClick = {
                    if (Build.VERSION.SDK_INT >= 33 &&
                        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                    ) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    else ModelDownloadService.start(context)
                }) { Text(if (m.partial > 0) "Continue" else "Download") }
            }
            is ModelStore.State.Downloading -> {
                LinearProgressIndicator(progress = { m.bytes.toFloat() / m.total }, modifier = Modifier.fillMaxWidth())
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${m.bytes / 1_000_000} of ${m.total / 1_000_000} MB", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = { app.models.cancel() }) { Text("Pause") }
                }
            }
            ModelStore.State.Verifying -> Text("Checking the file…", style = MaterialTheme.typography.bodySmall)
            ModelStore.State.Ready -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when (val e = engine) {
                        EngineHost.State.Loading -> "Loading…"
                        is EngineHost.State.Ready -> "Loaded on the ${e.processor} in ${"%.1f".format(e.loadMs / 1000.0)} s. ${e.note}".trim()
                        is EngineHost.State.Failed -> "Could not load: ${e.message}"
                        EngineHost.State.Unloaded -> "On this phone. It loads when the keyboard opens."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = {
                    app.engine.unloadNow()
                    app.models.delete()
                }) { Text("Delete") }
            }
            is ModelStore.State.Failed -> {
                Text(m.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                Button(onClick = { ModelDownloadService.start(context) }) { Text("Try again") }
            }
        }
    }

    Step(2, "Allow the microphone", done = microphone) {
        if (!microphone) Button(onClick = { askMicrophone.launch(Manifest.permission.RECORD_AUDIO) }) { Text("Allow") }
    }

    Step(3, "Turn on the Sotto keyboard", done = enabled) {
        if (!enabled) {
            Text(
                "Android shows a warning that a keyboard can read what you type. Sotto keeps it on the phone.",
                style = MaterialTheme.typography.bodySmall,
            )
            Button(onClick = {
                context.startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }) { Text("Open keyboard settings") }
        }
    }

    Step(4, "Switch to it", done = selected) {
        if (!selected) OutlinedButton(onClick = { imm.showInputMethodPicker() }, enabled = enabled) { Text("Choose keyboard") }
    }

    var sample by rememberSaveable { mutableStateOf("") }
    Text("Try it", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
    OutlinedTextField(
        value = sample,
        onValueChange = { sample = it },
        modifier = Modifier.fillMaxWidth(),
        minLines = 3,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        placeholder = { Text("Tap here, then tap the microphone and speak. Tap it again when you finish, or hold it while you talk.") },
    )
    if (app.engine.gpuCrashed) {
        Text(
            "The app closed while loading the model on the GPU, so it now uses the CPU, which is slower.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
        TextButton(onClick = {
            app.engine.forgetGpuCrash()
            app.engine.unloadNow()
            tick++
        }) { Text("Try the GPU again") }
    }
}

@Composable
private fun Step(number: Int, title: String, done: Boolean, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            val colors = MaterialTheme.colorScheme
            Box(
                Modifier.size(26.dp).clip(CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Surface(color = if (done) colors.primary else colors.surfaceVariant, modifier = Modifier.fillMaxSize()) {}
                Text(
                    if (done) "✓" else number.toString(),
                    color = if (done) colors.onPrimary else colors.onSurfaceVariant,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                content()
            }
        }
    }
}

// Settings

@Composable
private fun SettingsTab() {
    val app = LocalContext.current.sotto
    val s by app.settings.data.collectAsState()
    val set = app.settings::update

    Section("Language") {
        var open by remember { mutableStateOf(false) }
        Box {
            OutlinedButton(onClick = { open = true }) { Text(s.language.ifEmpty { "Detect automatically" }) }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                for (language in SettingsData.languages) {
                    DropdownMenuItem(
                        text = { Text(language.ifEmpty { "Detect automatically" }) },
                        onClick = {
                            set { it.copy(language = language) }
                            open = false
                        },
                    )
                }
            }
        }
    }

    Section("Editing") {
        Choice(
            listOf(CleanupLevel.VERBATIM to "Verbatim", CleanupLevel.LIGHT to "Light", CleanupLevel.SMART to "Smart"),
            s.cleanup,
        ) { level -> set { it.copy(cleanup = level) } }
        Text(
            when (s.cleanup) {
                CleanupLevel.VERBATIM -> "Exactly what the model heard, fillers and all."
                CleanupLevel.LIGHT -> "Removes um/uh and stuttered words. No second model pass."
                CleanupLevel.SMART -> "A second pass with the same model also applies self-corrections (“at five, actually six”), fixes punctuation and formats spoken lists. English only, and it roughly doubles the wait."
            },
            style = MaterialTheme.typography.bodySmall,
        )
    }

    Section("Tone") {
        Choice(
            listOf(Tone.FORMAL to "Formal", Tone.CASUAL to "Casual", Tone.VERY_CASUAL to "Very casual"),
            s.tone,
        ) { tone -> set { it.copy(tone = tone) } }
        Text(
            when (s.tone) {
                Tone.FORMAL -> "Hey, are you free for lunch tomorrow? Let's do 12 if that works."
                Tone.CASUAL -> "Hey, are you free for lunch tomorrow? Let's do 12 if that works"
                Tone.VERY_CASUAL -> "hey, are you free for lunch tomorrow? let's do 12 if that works"
            },
            style = MaterialTheme.typography.bodySmall,
        )
        Toggle("Casual in chat apps", "WhatsApp, Telegram, Messages, Discord, Slack, Signal", s.casualInChatApps) { on ->
            set { it.copy(casualInChatApps = on) }
        }
    }

    Section("Keyboard") {
        Toggle("Open on the microphone", "Off opens on the letters instead", s.openOnVoice) { on -> set { it.copy(openOnVoice = on) } }
        Toggle("Vibrate on key press", null, s.haptics) { on -> set { it.copy(haptics = on) } }
        Toggle("Keep history", "Password fields are never kept", s.keepHistory) { on -> set { it.copy(keepHistory = on) } }
    }

    Section("Speech engine") {
        Toggle(
            "Use an OpenAI-compatible API",
            "Sends your recordings to a service you choose, instead of using the model on this phone.",
            s.useApi,
        ) { on ->
            set { it.copy(useApi = on) }
            if (on) app.engine.unloadNow()
        }
        if (s.useApi) {
            val plain = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false)
            OutlinedTextField(
                value = s.apiBaseUrl, onValueChange = { v -> set { it.copy(apiBaseUrl = v) } },
                label = { Text("API address") }, placeholder = { Text("https://api.openai.com/v1") },
                singleLine = true, keyboardOptions = plain, modifier = Modifier.fillMaxWidth(),
            )
            // Read from the keystore only here, where the API is being set up.
            var key by remember { mutableStateOf(app.apiKey.get()) }
            OutlinedTextField(
                value = key,
                onValueChange = {
                    key = it
                    app.apiKey.set(it)
                },
                label = { Text("API key") }, placeholder = { Text("Empty if the server needs none") },
                singleLine = true, visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = s.apiModel, onValueChange = { v -> set { it.copy(apiModel = v) } },
                label = { Text("Transcription model") }, placeholder = { Text("gpt-4o-mini-transcribe") },
                singleLine = true, keyboardOptions = plain, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = s.apiCleanupModel, onValueChange = { v -> set { it.copy(apiCleanupModel = v) } },
                label = { Text("Editing model (optional)") }, placeholder = { Text("for example gpt-4o-mini") },
                singleLine = true, keyboardOptions = plain, modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Sotto adds /audio/transcriptions to the address. The key is stored encrypted with this phone's keystore. " +
                    "The editing model does the Smart pass; without one, Smart behaves like Light.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }

    if (!s.useApi) Section("Model") {
        Toggle("Use the GPU", "Much faster on most phones. Turn off if dictation fails.", s.useGpu) { on ->
            set { it.copy(useGpu = on) }
            app.engine.unloadNow()
        }
        Text("Free its memory after", style = MaterialTheme.typography.bodyMedium)
        Choice(listOf(1 to "1 min", 5 to "5 min", 30 to "30 min", 0 to "Never"), s.unloadAfterMinutes) { minutes ->
            set { it.copy(unloadAfterMinutes = minutes) }
        }
        Text(
            "The model holds 1 to 3 GB while loaded. After it is freed, the next dictation waits a few seconds for it to load again.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun <T> Choice(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((value, label) in options) {
            FilterChip(selected = value == selected, onClick = { onSelect(value) }, label = { Text(label) })
        }
    }
}

@Composable
private fun Toggle(title: String, detail: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

// Dictionary

@Composable
private fun DictionaryTab() {
    val app = LocalContext.current.sotto
    val s by app.settings.data.collectAsState()
    val set = app.settings::update

    Section("Names and terms") {
        Text("Words the model should spell exactly, such as names and product terms.", style = MaterialTheme.typography.bodySmall)
        for (term in s.vocabulary) {
            Entry(term, null) { set { it.copy(vocabulary = it.vocabulary - term) } }
        }
        AddRow("Term", null) { term, _ ->
            set { if (term in it.vocabulary) it else it.copy(vocabulary = it.vocabulary + term) }
        }
    }

    Section("Replacements") {
        Text("When the model writes the first, type the second instead.", style = MaterialTheme.typography.bodySmall)
        for (r in s.replacements) {
            Entry(r.heard, r.written) { set { it.copy(replacements = it.replacements - r) } }
        }
        AddRow("Heard", "Written") { heard, written ->
            set { it.copy(replacements = it.replacements + Replacement(heard, written)) }
        }
    }

    Section("Snippets") {
        Text("Say the phrase to type the whole text.", style = MaterialTheme.typography.bodySmall)
        for (snippet in s.snippets) {
            Entry(snippet.trigger, snippet.expansion) { set { it.copy(snippets = it.snippets - snippet) } }
        }
        AddRow("Phrase", "Text to type") { trigger, expansion ->
            set { it.copy(snippets = it.snippets + Snippet(trigger, expansion)) }
        }
    }
}

@Composable
private fun Entry(first: String, second: String?, onRemove: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            if (second == null) first else "$first  →  $second",
            modifier = Modifier.weight(1f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        TextButton(onClick = onRemove) { Text("Remove") }
    }
}

@Composable
private fun AddRow(firstLabel: String, secondLabel: String?, onAdd: (String, String) -> Unit) {
    var first by rememberSaveable { mutableStateOf("") }
    var second by rememberSaveable { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(first, { first = it }, label = { Text(firstLabel) }, singleLine = true, modifier = Modifier.weight(1f))
        if (secondLabel != null) {
            OutlinedTextField(second, { second = it }, label = { Text(secondLabel) }, modifier = Modifier.weight(1f))
        }
        Button(
            enabled = first.isNotBlank() && (secondLabel == null || second.isNotBlank()),
            onClick = {
                onAdd(first.trim(), second.trim())
                first = ""
                second = ""
            },
        ) { Text("Add") }
    }
}

// History

@Composable
private fun HistoryTab() {
    val context = LocalContext.current
    val app = context.sotto
    val entries by app.history.entries.collectAsState()
    var copied by remember { mutableStateOf<Long?>(null) }

    if (entries.isEmpty()) {
        Text("What you dictate appears here. It is stored only on this phone.", style = MaterialTheme.typography.bodyMedium)
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Tap an entry to copy it.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        TextButton(onClick = { app.history.clear() }) { Text("Clear all") }
    }
    for (entry in entries) {
        Column(
            Modifier.fillMaxWidth().clickable {
                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Sotto", entry.text))
                copied = entry.time
            }.padding(vertical = 6.dp),
        ) {
            Text(entry.text)
            Row {
                Text(
                    DateUtils.getRelativeTimeSpanString(entry.time, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString() +
                        (if (entry.app.isNotEmpty()) " · ${entry.app}" else ""),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (copied == entry.time) {
                    Spacer(Modifier.width(8.dp))
                    Text("Copied", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
        HorizontalDivider(color = Color.Gray.copy(alpha = 0.25f))
    }
}
