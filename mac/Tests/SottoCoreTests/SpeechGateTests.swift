import XCTest
@testable import SottoCore

final class SpeechGateTests: XCTestCase {
    func testDigitalSilenceIsNotSpeech() {
        XCTAssertFalse(SpeechGate.containsSpeech(frameRMS: [Float](repeating: 0, count: 200)))
    }

    func testSteadyRoomNoiseIsNotSpeech() {
        let noise = (0..<200).map { i in Float(0.008 + 0.001 * sin(Double(i))) }
        XCTAssertFalse(SpeechGate.containsSpeech(frameRMS: noise))
    }

    func testNormalSpeechIsSpeechEvenWithoutPauses() {
        XCTAssertTrue(SpeechGate.containsSpeech(frameRMS: [Float](repeating: 0.08, count: 40)))
    }

    func testWhisperOverQuietRoomIsSpeech() {
        var frames = [Float](repeating: 0.0008, count: 100)
        for i in 30..<70 { frames[i] = 0.006 }
        XCTAssertTrue(SpeechGate.containsSpeech(frameRMS: frames))
    }

    func testTooShortIsNotSpeech() {
        XCTAssertFalse(SpeechGate.containsSpeech(frameRMS: [0.5, 0.5]))
    }

    func testKeyClicksInAQuietRoomAreNotSpeech() {
        // Two sharp clicks (key down, key up) of 40 ms each over a -52 dBFS room.
        var frames = [Float](repeating: 0.0025, count: 150)
        for i in [3, 4, 140, 141] { frames[i] = 0.03 }
        XCTAssertFalse(SpeechGate.containsSpeech(frameRMS: frames))
    }

    func testOneShortWordIsSpeech() {
        var frames = [Float](repeating: 0.002, count: 60)
        for i in 20..<32 { frames[i] = 0.04 }  // "yes": 240 ms
        XCTAssertTrue(SpeechGate.containsSpeech(frameRMS: frames))
    }

    func testFramesComputeRMSPerWindow() {
        let samples = [Float](repeating: 0.5, count: 320) + [Float](repeating: 0, count: 320) + [Float](repeating: 1, count: 100)
        let frames = samples.withUnsafeBufferPointer { SpeechGate.frames(of: $0) }
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0], 0.5, accuracy: 1e-6)
        XCTAssertEqual(frames[1], 0, accuracy: 1e-6)
    }
}
