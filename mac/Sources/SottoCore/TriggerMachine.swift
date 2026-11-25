import Foundation

/// The dictation key's behaviour as a pure state machine, so it can be tested
/// without a keyboard:
///
///   idle ─down─▶ holding ─up after a real hold─▶ processing ─done─▶ idle
///                   │ up after a quick tap
///                   ▼
///               tapPending ─down again in time─▶ handsFree ─down─▶ processing
///                   │ no second tap
///                   ▼
///                  idle (recording discarded)
///
/// Escape cancels from any active state and is swallowed. Any other key during
/// a hold cancels quietly: the user is typing a shortcut (fn+arrow, ⌥+letter).
public struct TriggerMachine {
    public enum State: Equatable {
        case idle, holding, tapPending, handsFree, processing
    }

    public enum Input: Equatable {
        case keyDown, keyUp, escape, otherKey
        /// The wait for a second tap ran out.
        case tapWindowExpired
        /// The recording hit its maximum length.
        case limitReached
        /// Transcription finished, failed or was abandoned.
        case processingEnded
    }

    public enum Action: Equatable {
        case startRecording
        /// Stop recording and transcribe.
        case finishRecording
        /// Stop recording and throw the audio away. `quiet` means show nothing.
        case discardRecording(quiet: Bool)
        /// Ignore the transcription that is in flight.
        case abandonProcessing
        case startTapWindow, stopTapWindow
        case enteredHandsFree
        /// The key event must not reach the focused app.
        case swallowKey
    }

    public private(set) var state: State = .idle
    private var pressedAt: TimeInterval = 0

    /// A press shorter than this is a tap, not a hold.
    public var tapThreshold: TimeInterval = 0.3

    public init() {}

    /// Back to idle without side effects, for when recording could not start.
    public mutating func reset() {
        state = .idle
    }

    public mutating func handle(_ input: Input, at time: TimeInterval) -> [Action] {
        switch (state, input) {
        case (.idle, .keyDown):
            state = .holding
            pressedAt = time
            return [.startRecording]

        case (.holding, .keyUp):
            if time - pressedAt >= tapThreshold {
                state = .processing
                return [.finishRecording]
            }
            state = .tapPending
            return [.startTapWindow]
        case (.holding, .otherKey):
            state = .idle
            return [.discardRecording(quiet: true)]
        case (.holding, .escape):
            state = .idle
            return [.discardRecording(quiet: false), .swallowKey]
        case (.holding, .limitReached):
            state = .processing
            return [.finishRecording]

        case (.tapPending, .keyDown):
            state = .handsFree
            return [.stopTapWindow, .enteredHandsFree]
        case (.tapPending, .tapWindowExpired):
            state = .idle
            return [.discardRecording(quiet: true)]
        case (.tapPending, .otherKey):
            state = .idle
            return [.stopTapWindow, .discardRecording(quiet: true)]
        case (.tapPending, .escape):
            state = .idle
            return [.stopTapWindow, .discardRecording(quiet: false), .swallowKey]

        case (.handsFree, .keyDown), (.handsFree, .limitReached):
            state = .processing
            return [.finishRecording]
        case (.handsFree, .escape):
            state = .idle
            return [.discardRecording(quiet: false), .swallowKey]

        case (.processing, .escape):
            state = .idle
            return [.abandonProcessing, .swallowKey]
        case (.processing, .processingEnded):
            state = .idle
            return []

        default:
            return []
        }
    }
}
