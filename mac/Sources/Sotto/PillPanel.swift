import AppKit
import SwiftUI

/// The floating indicator at the bottom of the screen. It never takes focus
/// and ignores the mouse, so the app being dictated into stays active.
final class PillPanel: NSPanel {
    static let size = NSSize(width: 520, height: 72)

    init(controller: DictationController) {
        super.init(
            contentRect: NSRect(origin: .zero, size: Self.size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .statusBar
        ignoresMouseEvents = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        let host = NSHostingView(rootView: PillView(controller: controller))
        host.frame = NSRect(origin: .zero, size: Self.size)
        contentView = host
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Bottom centre of the screen the pointer is on.
    func present() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        setFrameOrigin(NSPoint(x: visible.midX - Self.size.width / 2, y: visible.minY + 18))
        orderFrontRegardless()
    }
}

struct PillView: View {
    @ObservedObject var controller: DictationController

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear
            content
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(Capsule().fill(Color.black.opacity(0.86)))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
                .shadow(color: .black.opacity(0.3), radius: 8, y: 3)
                .padding(.bottom, 12)
                .opacity(controller.phase == .idle ? 0 : 1)
                .scaleEffect(controller.phase == .idle ? 0.85 : 1, anchor: .bottom)
                .animation(.spring(response: 0.28, dampingFraction: 0.8), value: controller.phase)
        }
        .frame(width: PillPanel.size.width, height: PillPanel.size.height)
    }

    @ViewBuilder private var content: some View {
        switch controller.phase {
        case .idle:
            Color.clear.frame(width: 40)
        case .recording(let handsFree):
            HStack(spacing: 9) {
                if handsFree {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.75))
                }
                Waveform(levels: controller.levels)
            }
        case .processing:
            ThinkingDots()
        case .notice(let message, let isError):
            HStack(spacing: 7) {
                Image(systemName: isError ? "exclamationmark.triangle.fill" : "info.circle.fill")
                    .foregroundStyle(isError ? Color.orange : Color.white.opacity(0.7))
                Text(message).lineLimit(1)
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.white)
        }
    }
}

private struct Waveform: View {
    let levels: [Float]

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(Color.white)
                    .frame(width: 3, height: 3 + CGFloat(level) * 19)
            }
        }
        .frame(height: 22)
        .animation(.linear(duration: 0.06), value: levels)
    }
}

private struct ThinkingDots: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { i in
                    let wave = (sin(t * 6 - Double(i) * 0.9) + 1) / 2
                    Circle()
                        .fill(Color.white.opacity(0.35 + 0.65 * wave))
                        .frame(width: 6, height: 6)
                        .offset(y: -2.5 * wave)
                }
            }
            .frame(width: 44, height: 22)
        }
    }
}
