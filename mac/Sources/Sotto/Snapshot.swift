import AppKit
import SwiftUI
import SottoCore

/// `Sotto --snapshot DIR` draws the settings tabs and the pill states into PNG files.
/// The app renders its own views, so no screen-recording permission is involved.
/// Used to check the interface after a change.
enum Snapshot {
    static func run(directory: String) -> Never {
        let out = URL(fileURLWithPath: directory)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let settings = SettingsStore.shared
        let history = HistoryStore.shared
        let engine = Engine()
        let navigation = SettingsNavigation()

        let tabs: [(String, SettingsTab)] = [
            ("setup", .setup), ("general", .general), ("style", .style),
            ("dictionary", .dictionary), ("snippets", .snippets), ("history", .history),
        ]
        for (name, tab) in tabs {
            navigation.tab = tab
            let view = SettingsView(store: settings, engine: engine, history: history, navigation: navigation, restartEngine: {})
            write(view, size: NSSize(width: 620, height: 600), titled: true, to: out.appendingPathComponent("settings-\(name).png"))
        }

        // The API settings, with made-up values that are never saved.
        var api = SettingsData()
        api.engineKind = .cloud
        api.apiCleanupModel = "gpt-4o-mini"
        navigation.tab = .general
        write(SettingsView(store: SettingsStore(preview: api), engine: engine, history: history, navigation: navigation, restartEngine: {}),
              size: NSSize(width: 620, height: 1040), titled: true, to: out.appendingPathComponent("settings-api.png"))

        let controller = DictationController(settings: settings, engine: engine, history: history)
        var wave: [Float] = []
        for i in 0..<DictationController.barCount {
            let x = Double(i)
            let value: Double = 0.5 + 0.45 * sin(x * 0.9) * cos(x * 0.35)
            wave.append(Float(value))
        }
        let states: [(String, DictationController.Phase)] = [
            ("recording", .recording(handsFree: false)),
            ("handsfree", .recording(handsFree: true)),
            ("processing", .processing),
            ("notice", .notice("Didn't catch that", isError: false)),
            ("error", .notice("Microphone access is off — see Settings", isError: true)),
        ]
        for (name, phase) in states {
            controller.preview(phase: phase, levels: wave)
            let view = PillView(controller: controller)
                .background(LinearGradient(colors: [Color(white: 0.92), Color(white: 0.55)], startPoint: .top, endPoint: .bottom))
            write(view, size: PillPanel.size, titled: false, to: out.appendingPathComponent("pill-\(name).png"))
        }
        print("Wrote snapshots to \(out.path)")
        exit(0)
    }

    private static func write<V: View>(_ view: V, size: NSSize, titled: Bool, to url: URL) {
        let window = NSWindow(
            contentRect: NSRect(origin: NSPoint(x: -4000, y: -4000), size: size),
            styleMask: titled ? [.titled] : [.borderless], backing: .buffered, defer: false)
        window.contentViewController = NSHostingController(rootView: view)
        window.setContentSize(size)
        window.orderBack(nil)  // far off-screen; controls only draw fully inside a window
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        guard let target = window.contentView?.superview ?? window.contentView,
              let rep = target.bitmapImageRepForCachingDisplay(in: target.bounds)
        else { return }
        target.cacheDisplay(in: target.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
        window.orderOut(nil)
    }
}
