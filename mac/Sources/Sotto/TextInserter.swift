import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// Reads the text left of the cursor and puts dictated text into the focused
/// field. Insertion is a clipboard paste followed by restoring the clipboard,
/// which works in every app that accepts ⌘V.
enum TextInserter {
    static var accessibilityGranted: Bool { AXIsProcessTrusted() }

    static func promptForAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    // MARK: Context

    /// Up to 200 characters before the cursor in the focused text field.
    /// "" means the cursor is at the very start; nil means the field is not readable.
    static func textBeforeCursor() -> String? {
        guard accessibilityGranted else { return nil }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.25)

        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focusedRef, CFGetTypeID(focusedRef) == AXUIElementGetTypeID()
        else { return nil }
        let element = focusedRef as! AXUIElement
        AXUIElementSetMessagingTimeout(element, 0.25)

        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
              let rangeRef, CFGetTypeID(rangeRef) == AXValueGetTypeID()
        else { return nil }
        var selection = CFRange()
        guard AXValueGetValue(rangeRef as! AXValue, .cfRange, &selection), selection.location >= 0 else { return nil }
        if selection.location == 0 { return "" }

        let length = min(200, selection.location)
        var wanted = CFRange(location: selection.location - length, length: length)
        if let wantedValue = AXValueCreate(.cfRange, &wanted) {
            var textRef: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(
                element, kAXStringForRangeParameterizedAttribute as CFString, wantedValue, &textRef) == .success,
               let text = textRef as? String {
                return text
            }
        }
        // Fall back to the whole value for fields without ranged reads.
        var valueRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef) == .success,
           let value = valueRef as? String {
            let ns = value as NSString
            guard selection.location <= ns.length else { return nil }
            return ns.substring(with: NSRange(location: selection.location - length, length: length))
        }
        return nil
    }

    // MARK: Paste

    /// Apps that read the clipboard late: restoring too early pastes the old contents.
    private static func restoreDelay(forBundleID bundleID: String?) -> TimeInterval {
        guard let id = bundleID?.lowercased() else { return 0.5 }
        let remoteDesktops = ["vnc", "teamviewer", "anydesk", "com.microsoft.rdc", "com.vmware", "com.citrix", "parallels"]
        if remoteDesktops.contains(where: id.contains) { return 5 }
        let slowReaders = ["com.microsoft.word", "com.microsoft.outlook", "net.whatsapp.whatsapp"]
        if slowReaders.contains(where: id.contains) { return 3 }
        return 0.5
    }

    /// Pastes `text` into the frontmost app. Returns false when it could only
    /// be left on the clipboard (no Accessibility permission).
    @discardableResult
    static func paste(_ text: String, targetBundleID: String?, restoreClipboard: Bool) -> Bool {
        let pasteboard = NSPasteboard.general

        // Keep everything that is on the clipboard, in every format.
        let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        guard accessibilityGranted else { return false }

        // Tell clipboard managers this entry is temporary.
        pasteboard.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        let ourChange = pasteboard.changeCount

        postCommandV()

        if restoreClipboard {
            DispatchQueue.main.asyncAfter(deadline: .now() + restoreDelay(forBundleID: targetBundleID)) {
                // If anything else wrote to the clipboard meanwhile, it is not ours to overwrite.
                guard pasteboard.changeCount == ourChange else { return }
                pasteboard.clearContents()
                let items: [NSPasteboardItem] = saved.map { pairs in
                    let item = NSPasteboardItem()
                    for (type, data) in pairs { item.setData(data, forType: type) }
                    return item
                }
                if !items.isEmpty { pasteboard.writeObjects(items) }
            }
        }
        return true
    }

    private static func postCommandV() {
        // A private source ignores modifiers the user may still be holding (the dictation key).
        let source = CGEventSource(stateID: .privateState)
        let key = keyCodeForV()
        let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    /// The key that types "v" in the current layout (9 on QWERTY, different on Dvorak and others).
    private static func keyCodeForV() -> CGKeyCode {
        let fallback = CGKeyCode(kVK_ANSI_V)
        guard let inputSource = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(inputSource, kTISPropertyUnicodeKeyLayoutData)
        else { return fallback }
        let layoutData = unsafeBitCast(raw, to: CFData.self) as Data
        return layoutData.withUnsafeBytes { bytes -> CGKeyCode in
            guard let layout = bytes.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return fallback }
            for code in 0..<UInt16(50) {
                var deadKeys: UInt32 = 0
                var length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(
                    layout, code, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, chars.count, &length, &chars)
                if status == noErr, length == 1, chars[0] == UniChar(UInt8(ascii: "v")) {
                    return code
                }
            }
            return fallback
        }
    }
}
