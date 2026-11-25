import XCTest
@testable import SottoCore

final class CloudTests: XCTestCase {
    private let config = CloudConfig(baseURL: "https://api.example.com/v1/", apiKey: " sk-test ", model: "whisper-1", cleanupModel: "gpt-mini")

    func testTranscriptionRequestCarriesTheRecordingAndItsFields() throws {
        let wav = CloudAPI.wav([0, 0.5, -0.5, 1, -1, 2])
        let request = try CloudAPI.transcriptionRequest(config, wav: wav, language: "Portuguese", vocabulary: ["Sotto", "LiteRT"], boundary: "B")
        XCTAssertEqual(request.url?.absoluteString, "https://api.example.com/v1/audio/transcriptions")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer sk-test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=B")
        let body = try XCTUnwrap(request.httpBody)
        XCTAssertNotNil(body.range(of: wav))
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(text.contains("name=\"file\"; filename=\"speech.wav\""))
        XCTAssertTrue(text.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"))
        XCTAssertTrue(text.contains("name=\"language\"\r\n\r\npt\r\n"))
        XCTAssertTrue(text.contains("name=\"prompt\"\r\n\r\nSotto, LiteRT\r\n"))
        XCTAssertTrue(text.hasSuffix("--B--\r\n"))
    }

    func testNoKeyNoLanguageNoHints() throws {
        var open = config
        open.apiKey = ""
        let request = try CloudAPI.transcriptionRequest(open, wav: Data(), language: "", vocabulary: [], boundary: "B")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        let text = String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self)
        XCTAssertFalse(text.contains("name=\"language\""))
        XCTAssertFalse(text.contains("name=\"prompt\""))
    }

    func testWavHeaderAndClipping() {
        let wav = CloudAPI.wav([0, 0.5, -0.5, 1, -1, 2])
        XCTAssertEqual(wav.count, 44 + 12)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(wav.subdata(in: 24..<28), Data([0x80, 0x3E, 0, 0]))   // 16000 Hz
        XCTAssertEqual(wav.suffix(2), Data([0xFF, 0x7F]))                    // 2.0 is clipped to full scale
    }

    func testCleanupRequestHasInstructionsExamplesAndTheTranscript() throws {
        let request = try CloudAPI.cleanupRequest(config, text: "send it to john i mean jane", vocabulary: ["Sotto"])
        XCTAssertEqual(request.url?.absoluteString, "https://api.example.com/v1/chat/completions")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(json["model"] as? String, "gpt-mini")
        XCTAssertEqual(json["temperature"] as? Int, 0)
        let messages = try XCTUnwrap(json["messages"] as? [[String: String]])
        XCTAssertEqual(messages.count, 2 + Cleanup.shots.count * 2)
        XCTAssertEqual(messages.first?["role"], "system")
        XCTAssertTrue(messages.first?["content"]?.contains("exactly like this when they are said: Sotto.") == true)
        XCTAssertEqual(messages.last, ["role": "user", "content": "<transcript>send it to john i mean jane</transcript>"])
    }

    func testAnswersAreParsed() throws {
        XCTAssertEqual(CloudAPI.transcript(from: Data(#"{"text":" Hello there. "}"#.utf8)), "Hello there.")
        XCTAssertEqual(CloudAPI.transcript(from: Data("Just text\n".utf8)), "Just text")
        let chat = #"{"choices":[{"message":{"content":"<transcript>Send it to Jane.</transcript>"}}]}"#
        XCTAssertEqual(try CloudAPI.cleaned(from: Data(chat.utf8)), "Send it to Jane.")
        XCTAssertThrowsError(try CloudAPI.cleaned(from: Data("{}".utf8)))
        XCTAssertEqual(CloudAPI.failure(status: 401, body: Data(#"{"error":{"message":"Incorrect API key provided"}}"#.utf8)).description,
                       "The API answered 401: Incorrect API key provided")
        XCTAssertEqual(CloudAPI.failure(status: 502, body: Data()).description, "The API answered 502.")
    }

    func testIncompleteSettingsAreExplained() {
        XCTAssertEqual(CloudAPI.problem(config), "")
        var bad = config
        bad.baseURL = "api.openai.com"
        XCTAssertTrue(CloudAPI.problem(bad).contains("API address"))
        bad = config
        bad.model = " "
        XCTAssertTrue(CloudAPI.problem(bad).contains("model"))
    }

    func testGuardAcceptsCleanupsAndRejectsAnswers() {
        XCTAssertEqual(Cleanup.rejection(raw: "um so I was thinking we could uh meet at 5 actually 6", cleaned: "So I was thinking we could meet at 6.", vocabulary: []), "")
        XCTAssertEqual(Cleanup.rejection(raw: "push soto to git hub today", cleaned: "Push Sotto to GitHub today.", vocabulary: ["Sotto", "GitHub"]), "")
        XCTAssertNotEqual(Cleanup.rejection(raw: "What's the capital of France?", cleaned: "Paris.", vocabulary: []), "")
        XCTAssertNotEqual(Cleanup.rejection(raw: "What's the capital of France?", cleaned: "The capital of France is Paris.", vocabulary: []), "")
        XCTAssertNotEqual(Cleanup.rejection(raw: "send it to john by friday", cleaned: "", vocabulary: []), "")
        let sentence = "On Monday we start with the planning meeting and sort the open issues by priority."
        let six = Array(repeating: sentence, count: 6).joined(separator: " ")
        XCTAssertNotEqual(Cleanup.rejection(raw: "This is a longer dictation meant to check the engine. I am going to describe the plan in detail. " + six, cleaned: six, vocabulary: []), "")
    }

    func testSettingsKeepTheEngineChoice() throws {
        let data = #"{"engineKind":"cloud","apiBaseURL":"http://localhost:8000/v1","microphoneUID":"abc"}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(SettingsData.self, from: data)
        XCTAssertEqual(s.engineKind, .cloud)
        XCTAssertEqual(s.cloudConfig(apiKey: "k"), CloudConfig(baseURL: "http://localhost:8000/v1", apiKey: "k", model: "gpt-4o-mini-transcribe", cleanupModel: ""))
        XCTAssertEqual(s.microphoneUID, "abc")
        XCTAssertEqual(SettingsData().engineKind, .local)
        // The key is never part of the settings file.
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(s), as: UTF8.self).lowercased().contains("apikey"))
    }
}
