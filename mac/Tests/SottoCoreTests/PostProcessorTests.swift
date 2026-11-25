import XCTest
@testable import SottoCore

final class PostProcessorTests: XCTestCase {
    private func run(_ s: String, cleanup: CleanupLevel = .light, tone: Tone = .formal,
                     replacements: [Replacement] = [], snippets: [Snippet] = []) -> String {
        PostProcessor.process(s, options: .init(cleanup: cleanup, tone: tone, replacements: replacements, snippets: snippets))
    }

    func testFillersAreRemovedAndSentenceRecapitalized() {
        XCTAssertEqual(run("Um, so I was thinking we could, uh, meet at 5."), "So I was thinking we could, meet at 5.")
        XCTAssertEqual(run("Second, uhm, bump the version."), "Second, bump the version.")
        XCTAssertEqual(run("It is done. Uh, next we ship."), "It is done. Next we ship.")
    }

    func testWordsContainingFillerLettersSurvive() {
        XCTAssertEqual(run("The umbrella and the hummus are in the drum."), "The umbrella and the hummus are in the drum.")
        XCTAssertEqual(run("Uhura hummed."), "Uhura hummed.")
    }

    func testStuttersCollapseButDeliberateDoublesStay() {
        XCTAssertEqual(run("I I think the the cache is stale"), "I think the cache is stale")
        XCTAssertEqual(run("He said that that was fine, bye bye"), "He said that that was fine, bye bye")
    }

    func testVerbatimLeavesEverything() {
        XCTAssertEqual(run("Um, the the thing.", cleanup: .verbatim), "Um, the the thing.")
    }

    func testNumbersAreNotTreatedAsStutters() {
        XCTAssertEqual(run("Call 5 5 5 0 1 2 3"), "Call 5 5 5 0 1 2 3")
        XCTAssertEqual(run("Version 3.5 is out. e.g. this"), "Version 3.5 is out. e.g. this")
    }

    func testReplacementsMatchWholeWordsIgnoringCase() {
        let r = [Replacement(heard: "soto", written: "Sotto"), Replacement(heard: "git hub", written: "GitHub")]
        XCTAssertEqual(run("Push soto to Git  Hub, not sotoro.", replacements: r), "Push Sotto to GitHub, not sotoro.")
    }

    func testReplacementTemplateCharactersAreLiteral() {
        let r = [Replacement(heard: "price", written: "$5 \\ each")]
        XCTAssertEqual(run("The price", replacements: r), "The $5 \\ each")
    }

    func testSnippetSaidAloneReplacesTheWholeUtterance() {
        let s = [Snippet(trigger: "my address", expansion: "1 Infinite Loop\nCupertino, CA")]
        XCTAssertEqual(run("My address.", snippets: s), "1 Infinite Loop\nCupertino, CA")
    }

    func testSnippetInsideSentenceAndToneNotApplied() {
        let s = [Snippet(trigger: "calendar link", expansion: "https://cal.example/me")]
        XCTAssertEqual(run("Book a slot at calendar link.", tone: .veryCasual, snippets: s), "Book a slot at https://cal.example/me.")
    }

    func testTone() {
        let s = "Hey, are you free tomorrow? I'm around. API access works. Let's do 12."
        XCTAssertEqual(run(s, tone: .formal), s)
        XCTAssertEqual(run(s, tone: .casual), "Hey, are you free tomorrow? I'm around. API access works. Let's do 12")
        XCTAssertEqual(run(s, tone: .veryCasual), "hey, are you free tomorrow? I'm around. API access works. let's do 12")
    }

    func testToneLeavesListsAndEllipsesAlone() {
        XCTAssertEqual(run("Three things:\n1. Ship.\n2. Rest.", tone: .veryCasual), "Three things:\n1. Ship.\n2. Rest.")
        XCTAssertEqual(run("Well...", tone: .casual), "Well...")
    }

    func testFitAddsSpaceAndContinuesSentence() {
        XCTAssertEqual(PostProcessor.fit("And then we left.", after: "We ate"), " and then we left.")
        XCTAssertEqual(PostProcessor.fit("Next sentence.", after: "Done."), " Next sentence.")
        XCTAssertEqual(PostProcessor.fit("Next sentence.", after: "Done. "), "Next sentence.")
        XCTAssertEqual(PostProcessor.fit("Hello.", after: ""), "Hello.")
        XCTAssertEqual(PostProcessor.fit("Hello.", after: nil), "Hello.")
        XCTAssertEqual(PostProcessor.fit("Hello", after: "say ("), "Hello")
    }

    func testFitKeepsCapitalsThatMatter() {
        XCTAssertEqual(PostProcessor.fit("I think so.", after: "well,"), " I think so.")
        XCTAssertEqual(PostProcessor.fit("API keys rotate.", after: "the"), " API keys rotate.")
        XCTAssertEqual(PostProcessor.fit("Sotto works.", after: "and", protectedTerms: ["Sotto"]), " Sotto works.")
        XCTAssertEqual(PostProcessor.fit("New line", after: "first line\n"), "New line")
    }

    func testEmptyAndFillerOnlyInput() {
        XCTAssertEqual(run("   "), "")
        XCTAssertEqual(run("Um, uh."), "")
    }

    func testSeveralDictationKeys() throws {
        let data = #"{"hotkeys":["rightCommand","fn","fn","nonsense"]}"#.data(using: .utf8)!
        var s = try JSONDecoder().decode(SettingsData.self, from: data)
        XCTAssertEqual(s.hotkeys, [.fn, .rightCommand])
        XCTAssertEqual(s.hotkeyNames, "fn or right ⌘")

        let again = try JSONDecoder().decode(SettingsData.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(again.hotkeys, [.fn, .rightCommand])

        s.setHotkey(.rightOption, enabled: true)
        XCTAssertEqual(s.hotkeyNames, "fn, right ⌥ or right ⌘")
        s.setHotkey(.fn, enabled: false)
        s.setHotkey(.rightOption, enabled: false)
        XCTAssertEqual(s.hotkeys, [.rightCommand])
        s.setHotkey(.rightCommand, enabled: false)   // the last key stays
        XCTAssertEqual(s.hotkeys, [.rightCommand])

        XCTAssertEqual(SettingsData().hotkeys, [.fn])
        let empty = try JSONDecoder().decode(SettingsData.self, from: #"{"hotkeys":[]}"#.data(using: .utf8)!)
        XCTAssertEqual(empty.hotkeys, [.fn])
    }

    func testSettingsDecodeToleratesMissingFields() throws {
        let data = #"{"hotkey":"rightOption","language":"French"}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(SettingsData.self, from: data)
        XCTAssertEqual(s.hotkeys, [.rightOption])   // the single key of older builds
        XCTAssertEqual(s.language, "French")
        XCTAssertEqual(s.cleanup, .smart)
        XCTAssertEqual(s.microphoneUID, "")   // the system's input
        XCTAssertEqual(s.tone(forBundleID: "com.tinyspeck.slackmacgap"), .casual)
        XCTAssertEqual(s.tone(forBundleID: "com.example.other"), .formal)
    }
}
