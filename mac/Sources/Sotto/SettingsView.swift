import AppKit
import AVFoundation
import SottoCore
import SwiftUI
import UniformTypeIdentifiers

enum SettingsTab: Hashable {
    case setup, general, style, dictionary, snippets, history
}

final class SettingsNavigation: ObservableObject {
    @Published var tab: SettingsTab = .general
}

struct SettingsView: View {
    @ObservedObject var store: SettingsStore
    @ObservedObject var engine: Engine
    @ObservedObject var history: HistoryStore
    @ObservedObject var navigation: SettingsNavigation
    var restartEngine: () -> Void

    private static let tabs: [(SettingsTab, String)] = [
        (.setup, "Setup"), (.general, "General"), (.style, "Style"),
        (.dictionary, "Dictionary"), (.snippets, "Snippets"), (.history, "History"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $navigation.tab) {
                ForEach(Self.tabs, id: \.0) { tab, title in Text(title).tag(tab) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            Divider()
            Group {
                switch navigation.tab {
                case .setup: SetupTab(store: store, engine: engine)
                case .general: GeneralTab(store: store, engine: engine, restartEngine: restartEngine)
                case .style: StyleTab(store: store)
                case .dictionary: DictionaryTab(store: store)
                case .snippets: SnippetsTab(store: store)
                case .history: HistoryTab(store: store, history: history)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 620, height: 600)
    }
}

// MARK: - Setup

private struct SetupTab: View {
    @ObservedObject var store: SettingsStore
    @ObservedObject var engine: Engine
    @State private var microphone = AudioRecorder.microphoneStatus
    @State private var accessibility = TextInserter.accessibilityGranted
    @State private var scratch = ""
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Form {
            Section("Permissions") {
                row(done: microphone == .authorized,
                    title: "Microphone",
                    detail: "To hear what you dictate. Audio stays on this Mac.") {
                    if microphone == .notDetermined {
                        Button("Allow…") { AVCaptureDevice.requestAccess(for: .audio) { _ in } }
                    } else if microphone != .authorized {
                        Button("Open Settings") { open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") }
                    }
                }
                row(done: accessibility,
                    title: "Accessibility",
                    detail: "To notice the \(store.data.hotkeyNames) key in any app and paste the result at your cursor.") {
                    if !accessibility {
                        Button("Allow…") { TextInserter.promptForAccessibility() }
                    }
                }
            }
            Section("Engine") {
                if store.data.engineKind == .cloud {
                    row(done: apiProblem.isEmpty, title: "An OpenAI-compatible API", detail: apiProblem.isEmpty ? apiSummary : apiProblem) { EmptyView() }
                } else {
                    row(done: engineReady, title: "LFM3-Audio on MLX", detail: engineText) { EmptyView() }
                }
            }
            if store.data.hotkeys.contains(.fn), let action = globeKeyAction {
                Section {
                    HStack(alignment: .top) {
                        Image(systemName: "globe").foregroundStyle(.orange)
                        Text("macOS also \(action) when you tap the Globe key. Set “Press 🌐 key to” to “Do Nothing” in Keyboard settings, or use another dictation key in General.")
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("Keyboard Settings") { open("x-apple.systempreferences:com.apple.Keyboard-Settings.extension") }
                    }
                }
            }
            Section("Try it") {
                Text("Click in the box, hold **\(store.data.hotkeyNames)**, speak, and release. Tap it twice quickly for hands-free, then tap once to finish. Esc cancels.")
                    .foregroundStyle(.secondary)
                TextEditor(text: $scratch)
                    .font(.body)
                    .frame(height: 90)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
            }
        }
        .formStyle(.grouped)
        .onReceive(tick) { _ in
            microphone = AudioRecorder.microphoneStatus
            accessibility = TextInserter.accessibilityGranted
        }
    }

    private var engineReady: Bool {
        if case .ready = engine.state { return true }
        return false
    }

    private var apiProblem: String {
        CloudAPI.problem(store.data.cloudConfig(apiKey: ""))
    }

    private var apiSummary: String {
        "\(store.data.apiModel) at \(URL(string: store.data.apiBaseURL)?.host ?? store.data.apiBaseURL). Recordings are sent there."
    }

    private var engineText: String {
        switch engine.state {
        case .stopped: return "Stopped."
        case .loading(let what): return what
        case .ready(let model, let detail): return "\(model), \(detail)."
        case .failed(let why): return why
        }
    }

    /// What macOS does on a Globe-key tap, when that would collide with dictation.
    private var globeKeyAction: String? {
        let value = UserDefaults(suiteName: "com.apple.HIToolbox")?.object(forKey: "AppleFnUsageType") as? Int
        switch value {
        case 0: return nil
        case 1: return "switches the input source"
        case 3: return "starts Apple Dictation"
        default: return "opens the emoji picker"
        }
    }

    private func row<Trailing: View>(done: Bool, title: String, detail: String, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? Color.green : Color.secondary)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).fontWeight(.medium)
                Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            trailing()
        }
    }

    private func open(_ url: String) {
        if let url = URL(string: url) { NSWorkspace.shared.open(url) }
    }
}

// MARK: - General

private struct GeneralTab: View {
    @ObservedObject var store: SettingsStore
    @ObservedObject private var microphones = Microphones.shared
    @ObservedObject private var apiKey = ApiKeyStore.shared
    @State private var apiKeyDraft = ""
    @State private var apiKeyRefused = false
    @FocusState private var apiKeyFocused: Bool
    @ObservedObject var engine: Engine
    var restartEngine: () -> Void

    var body: some View {
        Form {
            Section("Dictation") {
                LabeledContent("Dictation keys") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Hotkey.allCases) { key in
                            Toggle(key.label, isOn: Binding(
                                get: { store.data.hotkeys.contains(key) },
                                set: { store.data.setHotkey(key, enabled: $0) }))
                                .toggleStyle(.checkbox)
                                // At least one key has to stay.
                                .disabled(store.data.hotkeys == [key])
                        }
                    }
                }
                Picker("Microphone", selection: $store.data.microphoneUID) {
                    Text("System default").tag("")
                    ForEach(microphones.all) { Text($0.name).tag($0.uid) }
                    // A saved choice that is unplugged stays selected, and says what happens meanwhile.
                    if !store.data.microphoneUID.isEmpty,
                       !microphones.all.contains(where: { $0.uid == store.data.microphoneUID }) {
                        Text("Not connected (using the system default)").tag(store.data.microphoneUID)
                    }
                }
                Picker("Language", selection: $store.data.language) {
                    ForEach(SettingsData.languages, id: \.self) { Text($0.isEmpty ? "Detect automatically" : $0).tag($0) }
                }
            }
            Section {
                Picker("Speech engine", selection: $store.data.engineKind) {
                    Text("On this Mac").tag(EngineKind.local)
                    Text("An OpenAI-compatible API").tag(EngineKind.cloud)
                }
                if store.data.engineKind == .cloud {
                    TextField("API address", text: $store.data.apiBaseURL, prompt: Text("https://api.openai.com/v1"))
                    SecureField("API key", text: $apiKeyDraft, prompt: Text("Leave empty if the server needs none"))
                        .focused($apiKeyFocused)
                        .onSubmit(saveApiKey)
                        .onChange(of: apiKeyFocused) { _, focused in if !focused { saveApiKey() } }
                    TextField("Transcription model", text: $store.data.apiModel, prompt: Text("gpt-4o-mini-transcribe"))
                    TextField("Editing model", text: $store.data.apiCleanupModel, prompt: Text("Optional, for example gpt-4o-mini"))
                }
            } header: {
                Text("Speech engine")
            } footer: {
                if store.data.engineKind == .cloud {
                    Text(apiKeyRefused
                         ? "The keychain refused to store the key."
                         : "Your recordings are sent to this address (Sotto adds /audio/transcriptions). The key is kept in your Mac's keychain. The editing model does the Smart pass; without one, Smart behaves like Light.")
                        .foregroundStyle(apiKeyRefused ? .red : .secondary)
                }
            }
            .onChange(of: store.data.engineKind, initial: true) { _, kind in
                // The keychain is only read once the API is actually being set up or used.
                guard kind == .cloud else { return }
                apiKey.load()
                apiKeyDraft = apiKey.key
            }
            Section("Cleanup") {
                Picker("Editing", selection: $store.data.cleanup) {
                    ForEach(CleanupLevel.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                Text(store.data.cleanup.explanation)
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Section("Behaviour") {
                Toggle("Play start and finish sounds", isOn: $store.data.sounds)
                Toggle("Put my clipboard back after pasting", isOn: $store.data.restoreClipboard)
                Toggle("Show Sotto in the Dock", isOn: $store.data.showDockIcon)
            }
            if store.data.engineKind == .local {
            Section("Model") {
                Picker("Checkpoint", selection: $store.data.model) {
                    Text("LFM3-Audio 2B · 8-bit (recommended, 2.3 GB)").tag(SettingsData.model8bit)
                    Text("LFM3-Audio 2B · 4-bit (smaller, less accurate, 1.6 GB)").tag(SettingsData.model4bit)
                }
                HStack {
                    Text(status).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                    Spacer()
                    Button("Restart Engine", action: restartEngine)
                }
            }
            }
        }
        .formStyle(.grouped)
        .onDisappear(perform: saveApiKey)
    }

    private func saveApiKey() {
        guard store.data.engineKind == .cloud else { return }
        apiKeyRefused = !apiKey.save(apiKeyDraft)
    }

    private var status: String {
        switch engine.state {
        case .stopped: return "Stopped"
        case .loading(let what): return what
        case .ready(_, let detail): return "Ready — \(detail)"
        case .failed(let why): return why
        }
    }
}

// MARK: - Style

private struct StyleTab: View {
    @ObservedObject var store: SettingsStore

    var body: some View {
        Form {
            Section("Everywhere else") {
                Picker("Default tone", selection: $store.data.defaultTone) {
                    ForEach(Tone.allCases) { Text($0.label).tag($0) }
                }
                Text(store.data.defaultTone.example).font(.callout).foregroundStyle(.secondary)
            }
            Section {
                ForEach($store.data.appTones) { $entry in
                    HStack {
                        Text(entry.name)
                        Spacer()
                        Picker("", selection: $entry.tone) {
                            ForEach(Tone.allCases) { Text($0.label).tag($0) }
                        }
                        .labelsHidden().frame(width: 130)
                        Button { store.data.appTones.removeAll { $0.bundleID == entry.bundleID } } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Button("Add App…", action: addApp)
            } header: {
                Text("Per app")
            } footer: {
                Text("Tone changes capitalization and the final period only. It never changes your words.")
            }
        }
        .formStyle(.grouped)
    }

    private func addApp() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.application]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url, let bundle = Bundle(url: url),
              let id = bundle.bundleIdentifier, !store.data.appTones.contains(where: { $0.bundleID == id })
        else { return }
        let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        store.data.appTones.append(AppTone(bundleID: id, name: name, tone: .casual))
    }
}

// MARK: - Dictionary

private struct DictionaryTab: View {
    @ObservedObject var store: SettingsStore
    @State private var newWord = ""

    var body: some View {
        Form {
            Section {
                ForEach(store.data.vocabulary, id: \.self) { word in
                    HStack {
                        Text(word)
                        Spacer()
                        Button { store.data.vocabulary.removeAll { $0 == word } } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.borderless)
                    }
                }
                HStack {
                    TextField("Name, acronym or term", text: $newWord).onSubmit(addWord)
                    Button("Add", action: addWord).disabled(trimmedWord.isEmpty)
                }
            } header: {
                Text("Words to spell exactly")
            } footer: {
                Text("Used by Smart cleanup to fix the spelling of names and jargon.")
            }
            Section {
                ForEach($store.data.replacements) { $r in
                    HStack {
                        TextField("heard", text: $r.heard)
                        Image(systemName: "arrow.right").foregroundStyle(.secondary)
                        TextField("written", text: $r.written)
                        Button { store.data.replacements.removeAll { $0.id == r.id } } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.borderless)
                    }
                    .labelsHidden()
                }
                Button("Add Replacement") { store.data.replacements.append(Replacement(heard: "", written: "")) }
            } header: {
                Text("Always replace")
            } footer: {
                Text("For words the model keeps mishearing: whenever it writes the left side, the right side is used. Works at every cleanup level.")
            }
        }
        .formStyle(.grouped)
    }

    private var trimmedWord: String { newWord.trimmingCharacters(in: .whitespaces) }

    private func addWord() {
        let word = trimmedWord
        guard !word.isEmpty, !store.data.vocabulary.contains(word) else { return }
        store.data.vocabulary.append(word)
        newWord = ""
    }
}

// MARK: - Snippets

private struct SnippetsTab: View {
    @ObservedObject var store: SettingsStore

    var body: some View {
        Form {
            Section {
                ForEach($store.data.snippets) { $s in
                    VStack(alignment: .leading) {
                        HStack {
                            TextField("When I say…", text: $s.trigger)
                            Button { store.data.snippets.removeAll { $0.id == s.id } } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(.borderless)
                        }
                        TextField("Insert this text", text: $s.expansion, axis: .vertical).lineLimit(1...4)
                    }
                    .labelsHidden()
                }
                Button("Add Snippet") { store.data.snippets.append(Snippet(trigger: "", expansion: "")) }
            } header: {
                Text("Spoken shortcuts")
            } footer: {
                Text("Say the phrase and the saved text is inserted in its place, for example “my calendar link” or “my address”.")
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - History

private struct HistoryTab: View {
    @ObservedObject var store: SettingsStore
    @ObservedObject var history: HistoryStore

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Toggle("Keep history on this Mac", isOn: $store.data.keepHistory)
                Spacer()
                Button("Clear", role: .destructive) { history.clear() }.disabled(history.entries.isEmpty)
            }
            .padding(12)
            Divider()
            if history.entries.isEmpty {
                Spacer()
                Text("Nothing dictated yet.").foregroundStyle(.secondary)
                Spacer()
            } else {
                List(history.entries) { entry in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(entry.text).textSelection(.enabled)
                            Text(caption(entry)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(entry.text, forType: .string)
                        } label: { Image(systemName: "doc.on.doc") }
                        .buttonStyle(.borderless)
                        .help("Copy")
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func caption(_ entry: HistoryEntry) -> String {
        var parts = [entry.date.formatted(date: .abbreviated, time: .shortened)]
        if !entry.app.isEmpty { parts.append(entry.app) }
        parts.append(String(format: "%.0f s of speech in %.2f s", entry.audioSeconds, entry.processingSeconds))
        return parts.joined(separator: " · ")
    }
}
