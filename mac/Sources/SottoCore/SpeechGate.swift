import Foundation

/// Decides whether a recording contains speech at all, from the loudness of its
/// 20 ms frames. The model, like every speech recognizer, invents a plausible
/// sentence when handed silence or steady noise, so those clips must not reach it.
public enum SpeechGate {
    /// Loud enough that it is speech whatever the background (about -34 dBFS).
    static let clearlyLoud: Float = 0.02
    /// Below this nothing was said, not even a whisper (about -48 dBFS).
    static let audible: Float = 0.004
    /// Speech rises and falls; fan noise does not. Speech frames must stand this far above the quiet ones.
    static let contrast: Float = 3
    /// The shortest words last about 200 ms. Clicks, such as the dictation key itself, last 20 to 40 ms.
    static let minimumActiveFrames = 10

    public struct Stats: Equatable {
        /// Loudness of the quietest tenth of the frames: the room.
        public var floor: Float
        /// Frames that stand clearly above the room.
        public var activeFrames: Int
        /// Frames loud enough to be speech in any room.
        public var loudFrames: Int
        public var containsSpeech: Bool
    }

    public static func analyze(frameRMS: [Float]) -> Stats {
        guard !frameRMS.isEmpty else { return Stats(floor: 0, activeFrames: 0, loudFrames: 0, containsSpeech: false) }
        let sorted = frameRMS.sorted()
        let floor = sorted[Int(Float(sorted.count - 1) * 0.10)]
        let threshold = max(audible, floor * contrast)
        let active = frameRMS.filter { $0 >= threshold }.count
        let loud = frameRMS.filter { $0 >= clearlyLoud }.count
        return Stats(
            floor: floor, activeFrames: active, loudFrames: loud,
            containsSpeech: active >= minimumActiveFrames || loud >= minimumActiveFrames)
    }

    public static func containsSpeech(frameRMS: [Float]) -> Bool {
        analyze(frameRMS: frameRMS).containsSpeech
    }

    /// Root-mean-square loudness of consecutive windows of `size` samples.
    public static func frames(of samples: UnsafeBufferPointer<Float>, size: Int = 320) -> [Float] {
        guard size > 0, samples.count >= size else { return [] }
        var out: [Float] = []
        out.reserveCapacity(samples.count / size)
        var start = 0
        while start + size <= samples.count {
            var sum: Float = 0
            for i in start..<(start + size) { sum += samples[i] * samples[i] }
            out.append((sum / Float(size)).squareRoot())
            start += size
        }
        return out
    }
}
