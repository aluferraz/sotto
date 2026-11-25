import AppKit
import Combine
import SottoCore
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let settings = SettingsStore.shared
    private let history = HistoryStore.shared
    private let engine = Engine()
    private let hotkeys = HotkeyMonitor()
    private let navigation = SettingsNavigation()
    private lazy var controller = DictationController(settings: settings, engine: engine, history: history)
    private lazy var pill = PillPanel(controller: controller)

    private var statusItem: NSStatusItem!
    private var settingsWindow: NSWindow?
    private var subscriptions = Set<AnyCancellable>()
    private var tapRetry: Timer?
    private var hideWork: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        updateIcon(for: .idle)
        NSApp.mainMenu = makeMainMenu()

        // With an API as the engine there is no model to load, and its key is read now so the
        // first dictation does not wait for the keychain.
        if settings.data.engineKind == .cloud {
            ApiKeyStore.shared.load()
        } else {
            engine.start(model: settings.data.model)
        }

        hotkeys.hotkeys = settings.data.hotkeys
        hotkeys.handler = { [weak self] event in self?.controller.handle(event) ?? false }
        startHotkeys()

        controller.$phase
            .receive(on: RunLoop.main)
            .sink { [weak self] phase in self?.phaseChanged(phase) }
            .store(in: &subscriptions)

        settings.$data.map(\.hotkeys).removeDuplicates().dropFirst()
            .sink { [weak self] in self?.hotkeys.hotkeys = $0 }
            .store(in: &subscriptions)

        settings.$data.map(\.model).removeDuplicates().dropFirst()
            .sink { [weak self] in
                guard let self, self.settings.data.engineKind == .local else { return }
                self.engine.start(model: $0)
            }
            .store(in: &subscriptions)

        settings.$data.map(\.engineKind).removeDuplicates().dropFirst()
            .sink { [weak self] kind in
                guard let self else { return }
                // The local model holds a few gigabytes; it only stays loaded while it is the engine.
                if kind == .cloud {
                    self.engine.stop()
                } else {
                    self.engine.start(model: self.settings.data.model)
                }
            }
            .store(in: &subscriptions)

        settings.$data.map(\.showDockIcon).removeDuplicates().dropFirst()
            .sink { [weak self] in self?.dockIconChanged(shown: $0) }
            .store(in: &subscriptions)

        // First launch, or a permission is missing: show the checklist.
        if !TextInserter.accessibilityGranted || AudioRecorder.microphoneStatus != .authorized {
            showSettings(tab: .setup)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        engine.stop()
    }

    /// Clicking the Dock icon opens the settings window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSettings(tab: nil)
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func dockIconChanged(shown: Bool) {
        NSApp.setActivationPolicy(shown ? .regular : .accessory)
        // Changing the policy can drop the window behind other apps.
        if settingsWindow?.isVisible == true {
            NSApp.activate(ignoringOtherApps: true)
            settingsWindow?.makeKeyAndOrderFront(nil)
        }
    }

    /// Shown only while the app is in the Dock; it also gives text fields their
    /// standard Cut/Copy/Paste shortcuts.
    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Sotto", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let prefs = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        prefs.target = self
        appMenu.addItem(prefs)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Sotto", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Sotto", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = window
        main.addItem(windowItem)
        NSApp.windowsMenu = window
        return main
    }

    /// The event tap cannot be created until Accessibility is granted, so keep trying.
    private func startHotkeys() {
        guard !hotkeys.start() else { return }
        tapRetry = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] timer in
            if self?.hotkeys.start() == true {
                timer.invalidate()
            }
        }
    }

    // MARK: Indicator

    private func phaseChanged(_ phase: DictationController.Phase) {
        updateIcon(for: phase)
        hideWork?.cancel()
        if phase == .idle {
            // Let the pill finish its fade before the window goes away.
            let work = DispatchWorkItem { [weak self] in self?.pill.orderOut(nil) }
            hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
        } else {
            pill.present()
        }
    }

    private func updateIcon(for phase: DictationController.Phase) {
        let name: String
        switch phase {
        case .recording: name = "waveform.circle.fill"
        case .processing: name = "ellipsis.circle"
        case .idle, .notice: name = "waveform"
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "Sotto")
        image?.isTemplate = true
        statusItem.button?.image = image
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let key = settings.data.hotkeyNames
        menu.addItem(disabled("Hold \(key) to dictate · double-tap for hands-free"))
        menu.addItem(disabled(engineLine))
        if !hotkeys.isRunning {
            menu.addItem(disabled("⚠︎ Waiting for Accessibility permission"))
        }
        menu.addItem(.separator())

        let copy = NSMenuItem(title: "Copy Last Transcript", action: #selector(copyLast), keyEquivalent: "")
        copy.target = self
        copy.isEnabled = !history.entries.isEmpty
        menu.addItem(copy)

        let prefs = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        prefs.target = self
        menu.addItem(prefs)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Sotto", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private var engineLine: String {
        switch engine.state {
        case .stopped: return "Engine stopped"
        case .loading(let what): return what
        case .ready(let model, _): return "Ready · \(model.split(separator: "/").last ?? "")"
        case .failed(let why): return "⚠︎ " + String(why.prefix(70))
        }
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func copyLast() {
        guard let last = history.entries.first else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(last.text, forType: .string)
    }

    @objc private func openSettings() {
        showSettings(tab: nil)
    }

    private func showSettings(tab: SettingsTab?) {
        if let tab { navigation.tab = tab }
        if settingsWindow == nil {
            let view = SettingsView(
                store: settings, engine: engine, history: history, navigation: navigation,
                restartEngine: { [weak self] in
                    guard let self else { return }
                    self.engine.start(model: self.settings.data.model)
                })
            let window = NSWindow(contentViewController: NSHostingController(rootView: view))
            window.title = "Sotto"
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.isReleasedWhenClosed = false
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }
}
