import Foundation
import SottoCore

/// Settings live in one JSON file so they are easy to inspect, back up or edit by hand.
final class SettingsStore: ObservableObject {
    static let shared = SettingsStore()

    @Published var data: SettingsData {
        didSet { if data != oldValue, persists { save() } }
    }

    private let url = Engine.supportDirectory.appendingPathComponent("settings.json")
    private let persists: Bool

    /// Settings that exist only in memory, for drawing the interface with made-up values.
    init(preview data: SettingsData) {
        self.data = data
        persists = false
    }

    private init() {
        persists = true
        if let raw = try? Data(contentsOf: url), let decoded = try? JSONDecoder().decode(SettingsData.self, from: raw) {
            data = decoded
        } else {
            data = SettingsData()
        }
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let raw = try? encoder.encode(data) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? raw.write(to: url, options: .atomic)
    }
}

struct HistoryEntry: Codable, Identifiable, Hashable {
    var id = UUID()
    var date: Date
    var app: String
    var raw: String
    var text: String
    var audioSeconds: Double
    var processingSeconds: Double
}

final class HistoryStore: ObservableObject {
    static let shared = HistoryStore()
    static let limit = 500

    @Published private(set) var entries: [HistoryEntry] = []

    private let url = Engine.supportDirectory.appendingPathComponent("history.json")

    private init() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let raw = try? Data(contentsOf: url), let decoded = try? decoder.decode([HistoryEntry].self, from: raw) {
            entries = decoded
        }
    }

    func add(_ entry: HistoryEntry) {
        entries.insert(entry, at: 0)
        if entries.count > Self.limit {
            entries.removeLast(entries.count - Self.limit)
        }
        save()
    }

    func clear() {
        entries.removeAll()
        save()
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let raw = try? encoder.encode(entries) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? raw.write(to: url, options: .atomic)
    }
}
