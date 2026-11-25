import XCTest
@testable import SottoCore

final class TriggerMachineTests: XCTestCase {
    func testHoldToTalk() {
        var m = TriggerMachine()
        XCTAssertEqual(m.handle(.keyDown, at: 0), [.startRecording])
        XCTAssertEqual(m.state, .holding)
        XCTAssertEqual(m.handle(.keyUp, at: 2.0), [.finishRecording])
        XCTAssertEqual(m.state, .processing)
        XCTAssertEqual(m.handle(.processingEnded, at: 2.7), [])
        XCTAssertEqual(m.state, .idle)
    }

    func testSingleTapIsDiscardedQuietly() {
        var m = TriggerMachine()
        _ = m.handle(.keyDown, at: 0)
        XCTAssertEqual(m.handle(.keyUp, at: 0.1), [.startTapWindow])
        XCTAssertEqual(m.state, .tapPending)
        XCTAssertEqual(m.handle(.tapWindowExpired, at: 0.5), [.discardRecording(quiet: true)])
        XCTAssertEqual(m.state, .idle)
    }

    func testDoubleTapGoesHandsFreeAndNextPressFinishes() {
        var m = TriggerMachine()
        _ = m.handle(.keyDown, at: 0)
        _ = m.handle(.keyUp, at: 0.1)
        XCTAssertEqual(m.handle(.keyDown, at: 0.25), [.stopTapWindow, .enteredHandsFree])
        XCTAssertEqual(m.state, .handsFree)
        // Releasing the second tap, and typing, do not end hands-free.
        XCTAssertEqual(m.handle(.keyUp, at: 0.35), [])
        XCTAssertEqual(m.handle(.otherKey, at: 1.0), [])
        XCTAssertEqual(m.state, .handsFree)
        XCTAssertEqual(m.handle(.keyDown, at: 8.0), [.finishRecording])
        XCTAssertEqual(m.state, .processing)
        // The release of that last press must not start anything.
        XCTAssertEqual(m.handle(.keyUp, at: 8.1), [])
        XCTAssertEqual(m.state, .processing)
    }

    func testShortcutDuringHoldCancelsQuietly() {
        var m = TriggerMachine()
        _ = m.handle(.keyDown, at: 0)
        XCTAssertEqual(m.handle(.otherKey, at: 0.05), [.discardRecording(quiet: true)])
        XCTAssertEqual(m.state, .idle)
        // The key is still physically down; its release must be ignored.
        XCTAssertEqual(m.handle(.keyUp, at: 0.4), [])
        XCTAssertEqual(m.state, .idle)
    }

    func testEscapeCancelsAndIsSwallowedOnlyWhenActive() {
        var m = TriggerMachine()
        XCTAssertEqual(m.handle(.escape, at: 0), [])  // idle: Escape belongs to the app

        _ = m.handle(.keyDown, at: 1)
        XCTAssertEqual(m.handle(.escape, at: 1.5), [.discardRecording(quiet: false), .swallowKey])
        XCTAssertEqual(m.state, .idle)

        _ = m.handle(.keyDown, at: 2)
        _ = m.handle(.keyUp, at: 3)
        XCTAssertEqual(m.handle(.escape, at: 3.1), [.abandonProcessing, .swallowKey])
        XCTAssertEqual(m.state, .idle)
    }

    func testKeyPressesWhileProcessingAreIgnored() {
        var m = TriggerMachine()
        _ = m.handle(.keyDown, at: 0)
        _ = m.handle(.keyUp, at: 1)
        XCTAssertEqual(m.handle(.keyDown, at: 1.1), [])
        XCTAssertEqual(m.handle(.keyUp, at: 1.2), [])
        XCTAssertEqual(m.state, .processing)
    }

    func testRecordingLimitFinishes() {
        var m = TriggerMachine()
        _ = m.handle(.keyDown, at: 0)
        XCTAssertEqual(m.handle(.limitReached, at: 300), [.finishRecording])
        XCTAssertEqual(m.handle(.limitReached, at: 301), [])
    }

    func testResetAfterFailedStart() {
        var m = TriggerMachine()
        _ = m.handle(.keyDown, at: 0)
        m.reset()
        XCTAssertEqual(m.handle(.keyUp, at: 1), [])
        XCTAssertEqual(m.handle(.keyDown, at: 2), [.startRecording])
    }
}
