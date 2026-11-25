import AppKit
import SottoCore

/// Watches the dictation keys system-wide with a session event tap. The tap is
/// active (not listen-only) so it needs only the Accessibility permission, and
/// so Escape can be swallowed while a recording is being cancelled.
final class HotkeyMonitor {
    enum Event {
        case down, up
        case escape
        case otherKey
    }

    /// Runs on the main thread. Return true from `.escape` to swallow the key.
    var handler: ((Event) -> Bool)?
    /// Any of these starts dictation. Only the one pressed first counts until it is released.
    var hotkeys: [Hotkey] = [.fn] {
        didSet { held = nil }
    }

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var held: Hotkey?

    var isRunning: Bool { tap != nil }

    /// Returns false while Accessibility permission is missing; call again later.
    @discardableResult
    func start() -> Bool {
        if tap != nil { return true }
        let mask: CGEventMask =
            (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(refcon).takeUnretainedValue()
            return monitor.handle(type: type, event: event)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque())
        else { return false }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        return true
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // The system switches a slow tap off; switch it back on.
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }

        case .flagsChanged:
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            guard let key = hotkeys.first(where: { $0.keyCode == keyCode }) else { break }
            let pressed = event.flags.rawValue & key.flagMask != 0
            if pressed, held == nil {
                held = key
                _ = handler?(.down)
            } else if !pressed, held == key {
                held = nil
                _ = handler?(.up)
            }

        case .keyDown:
            guard event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else { break }
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if keyCode == 53 {  // Escape
                if handler?(.escape) == true { return nil }
            } else {
                _ = handler?(.otherKey)
            }

        default:
            break
        }
        return Unmanaged.passUnretained(event)
    }
}
