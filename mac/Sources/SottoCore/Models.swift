import Foundation

/// A key that starts dictation. All are modifier keys, so they never type a character.
public enum Hotkey: String, Codable, CaseIterable, Identifiable {
    case fn, rightOption, rightCommand, rightControl

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .fn: return "fn (Globe)"
        case .rightOption: return "Right Option ⌥"
        case .rightCommand: return "Right Command ⌘"
        case .rightControl: return "Right Control ⌃"
        }
    }

    public var short: String {
        switch self {
        case .fn: return "fn"
        case .rightOption: return "right ⌥"
        case .rightCommand: return "right ⌘"
        case .rightControl: return "right ⌃"
        }
    }

    /// Virtual key code reported in the `flagsChanged` event.
    public var keyCode: Int64 {
        switch self {
        case .fn: return 63
        case .rightOption: return 61
        case .rightCommand: return 54
        case .rightControl: return 62
        }
    }

    /// Bit in the event flags that is set while the key is down. The right-hand
    /// keys use the device-dependent bits so the left-hand twin does not trigger.
    public var flagMask: UInt64 {
        switch self {
        case .fn: return 0x80_0000          // kCGEventFlagMaskSecondaryFn
        case .rightOption: return 0x40      // NX_DEVICERALTKEYMASK
        case .rightCommand: return 0x10     // NX_DEVICERCMDKEYMASK
        case .rightControl: return 0x2000   // NX_DEVICERCTLKEYMASK
        }
    }
}

public enum CleanupLevel: String, Codable, CaseIterable, Identifiable {
    case verbatim, light, smart
    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .verbatim: return "Verbatim"
        case .light: return "Light"
        case .smart: return "Smart"
        }
    }

    public var explanation: String {
        switch self {
        case .verbatim: return "Exactly what the model heard, fillers and all."
        case .light: return "Removes um/uh and stuttered words. No second model pass."
        case .smart: return "A second pass with the same model also applies self-corrections (“at five, actually six”), fixes punctuation and formats spoken lists. English only; adds about a third of a second."
        }
    }
}

public enum Tone: String, Codable, CaseIterable, Identifiable {
    case formal, casual, veryCasual
    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .formal: return "Formal"
        case .casual: return "Casual"
        case .veryCasual: return "Very casual"
        }
    }

    public var example: String {
        switch self {
        case .formal: return "Hey, are you free for lunch tomorrow? Let's do 12 if that works."
        case .casual: return "Hey, are you free for lunch tomorrow? Let's do 12 if that works"
        case .veryCasual: return "hey, are you free for lunch tomorrow? let's do 12 if that works"
        }
    }
}

public struct Replacement: Codable, Identifiable, Hashable {
    public var id = UUID()
    public var heard: String
    public var written: String
    public init(heard: String, written: String) { self.heard = heard; self.written = written }
}

public struct Snippet: Codable, Identifiable, Hashable {
    public var id = UUID()
    public var trigger: String
    public var expansion: String
    public init(trigger: String, expansion: String) { self.trigger = trigger; self.expansion = expansion }
}

public struct AppTone: Codable, Identifiable, Hashable {
    public var id: String { bundleID }
    public var bundleID: String
    public var name: String
    public var tone: Tone
    public init(bundleID: String, name: String, tone: Tone) {
        self.bundleID = bundleID; self.name = name; self.tone = tone
    }
}

public struct SettingsData: Codable, Equatable {
    public static let model8bit = "LiquidAI/LFM3-Audio-2B-MLX-8bit"
    public static let model4bit = "LiquidAI/LFM3-Audio-2B-MLX-4bit"

    /// Empty string means "let the model detect the language".
    public static let languages = [
        "", "English", "Arabic", "Chinese", "Danish", "Dutch", "Finnish", "French", "German", "Greek",
        "Hebrew", "Italian", "Japanese", "Korean", "Polish", "Portuguese", "Spanish", "Swedish", "Turkish",
    ]

    /// The keys that start dictation; any one of them does. Never empty, in `Hotkey.allCases` order.
    public var hotkeys: [Hotkey] = [.fn]
    public var language: String = "English"
    public var cleanup: CleanupLevel = .smart
    public var defaultTone: Tone = .formal
    public var appTones: [AppTone] = SettingsData.defaultAppTones
    public var vocabulary: [String] = []
    public var replacements: [Replacement] = []
    public var snippets: [Snippet] = []
    public var sounds: Bool = true
    public var restoreClipboard: Bool = true
    public var keepHistory: Bool = true
    public var showDockIcon: Bool = true
    public var model: String = SettingsData.model8bit

    public static let defaultAppTones: [AppTone] = [
        AppTone(bundleID: "com.apple.MobileSMS", name: "Messages", tone: .casual),
        AppTone(bundleID: "com.tinyspeck.slackmacgap", name: "Slack", tone: .casual),
        AppTone(bundleID: "com.hnc.Discord", name: "Discord", tone: .casual),
        AppTone(bundleID: "net.whatsapp.WhatsApp", name: "WhatsApp", tone: .casual),
        AppTone(bundleID: "ru.keepcoder.Telegram", name: "Telegram", tone: .casual),
    ]

    public init() {}

    // Decode field by field so a settings file written by an older build still loads.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = SettingsData()
        // Builds before the keys became a list stored a single "hotkey".
        let legacy = try? decoder.container(keyedBy: LegacyKeys.self)
        if let names = try? c.decode([String].self, forKey: .hotkeys) {
            hotkeys = SettingsData.normalized(names.compactMap(Hotkey.init(rawValue:)))
        } else if let one = try? legacy?.decode(Hotkey.self, forKey: .hotkey) {
            hotkeys = [one]
        } else {
            hotkeys = d.hotkeys
        }
        language = (try? c.decode(String.self, forKey: .language)) ?? d.language
        cleanup = (try? c.decode(CleanupLevel.self, forKey: .cleanup)) ?? d.cleanup
        defaultTone = (try? c.decode(Tone.self, forKey: .defaultTone)) ?? d.defaultTone
        appTones = (try? c.decode([AppTone].self, forKey: .appTones)) ?? d.appTones
        vocabulary = (try? c.decode([String].self, forKey: .vocabulary)) ?? d.vocabulary
        replacements = (try? c.decode([Replacement].self, forKey: .replacements)) ?? d.replacements
        snippets = (try? c.decode([Snippet].self, forKey: .snippets)) ?? d.snippets
        sounds = (try? c.decode(Bool.self, forKey: .sounds)) ?? d.sounds
        restoreClipboard = (try? c.decode(Bool.self, forKey: .restoreClipboard)) ?? d.restoreClipboard
        keepHistory = (try? c.decode(Bool.self, forKey: .keepHistory)) ?? d.keepHistory
        showDockIcon = (try? c.decode(Bool.self, forKey: .showDockIcon)) ?? d.showDockIcon
        model = (try? c.decode(String.self, forKey: .model)) ?? d.model
    }

    private enum LegacyKeys: String, CodingKey { case hotkey }

    /// In a fixed order, without repeats, and falling back to fn when nothing is left.
    public static func normalized(_ keys: [Hotkey]) -> [Hotkey] {
        let kept = Hotkey.allCases.filter(keys.contains)
        return kept.isEmpty ? [.fn] : kept
    }

    /// Adds or removes one dictation key. The last remaining key cannot be removed.
    public mutating func setHotkey(_ key: Hotkey, enabled: Bool) {
        var keys = hotkeys.filter { $0 != key }
        if enabled { keys.append(key) }
        if keys.isEmpty { return }
        hotkeys = SettingsData.normalized(keys)
    }

    /// The dictation keys as words: "fn", "fn or right ⌘", "fn, right ⌥ or right ⌘".
    public var hotkeyNames: String {
        let names = hotkeys.map(\.short)
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " or " + names[names.count - 1]
    }

    public func tone(forBundleID bundleID: String?) -> Tone {
        guard let bundleID, let match = appTones.first(where: { $0.bundleID == bundleID }) else {
            return defaultTone
        }
        return match.tone
    }

    /// Terms the cleanup pass should spell exactly: the dictionary plus the
    /// written side of every replacement.
    public var spellingHints: [String] {
        var seen = Set<String>()
        return (vocabulary + replacements.map(\.written))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }
}
