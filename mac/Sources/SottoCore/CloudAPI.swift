import Foundation

/// Where an OpenAI-compatible API lives and what to ask it for. The key is not part of the
/// settings file; it is kept in the keychain.
public struct CloudConfig: Equatable {
    /// The API's root, such as https://api.openai.com/v1.
    public var baseURL: String
    public var apiKey: String
    /// The transcription model's name at that API.
    public var model: String
    /// A chat model for the Smart editing pass; empty to skip that pass.
    public var cleanupModel: String

    public init(baseURL: String, apiKey: String, model: String, cleanupModel: String) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.model = model
        self.cleanupModel = cleanupModel
    }
}

public struct CloudError: Error, Equatable, CustomStringConvertible {
    public var description: String
    public init(_ description: String) { self.description = description }
}

/// The requests and answers of an OpenAI-compatible API, without any networking, so they can
/// be tested: `POST {base}/audio/transcriptions` for the speech and, optionally,
/// `POST {base}/chat/completions` for the Smart editing pass.
public enum CloudAPI {
    /// The codes these APIs expect, for the language names the settings use.
    public static let languageCodes: [String: String] = [
        "English": "en", "Arabic": "ar", "Chinese": "zh", "Danish": "da", "Dutch": "nl", "Finnish": "fi",
        "French": "fr", "German": "de", "Greek": "el", "Hebrew": "he", "Italian": "it", "Japanese": "ja",
        "Korean": "ko", "Polish": "pl", "Portuguese": "pt", "Spanish": "es", "Swedish": "sv", "Turkish": "tr",
    ]

    /// Empty when the configuration can be used; otherwise what is missing.
    public static func problem(_ config: CloudConfig) -> String {
        let address = config.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else {
            return "Enter the API address, for example https://api.openai.com/v1."
        }
        if config.model.trimmingCharacters(in: .whitespaces).isEmpty { return "Enter the name of the transcription model." }
        return ""
    }

    private static func endpoint(_ config: CloudConfig, _ path: String) -> URL? {
        var base = config.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + path)
    }

    private static func request(_ config: CloudConfig, _ path: String) throws -> URLRequest {
        guard let url = endpoint(config, path) else { throw CloudError(problem(config)) }
        var request = URLRequest(url: url, timeoutInterval: 120)
        request.httpMethod = "POST"
        let key = config.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        return request
    }

    /// A complete 16-bit mono WAV file at 16 kHz.
    public static func wav(_ samples: [Float], sampleRate: Int = 16_000) -> Data {
        var data = Data(capacity: 44 + samples.count * 2)
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + samples.count * 2)); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(sampleRate)); append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(UInt32(samples.count * 2))
        for sample in samples { append(Int16((max(-1, min(1, sample)) * 32767).rounded())) }
        return data
    }

    public static func transcriptionRequest(
        _ config: CloudConfig, wav: Data, language: String, vocabulary: [String], boundary: String = "sotto-\(UUID().uuidString)"
    ) throws -> URLRequest {
        var request = try request(config, "/audio/transcriptions")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
        body.append(wav)
        body.append(Data("\r\n".utf8))
        field("model", config.model.trimmingCharacters(in: .whitespaces))
        field("response_format", "json")
        if let code = languageCodes[language] { field("language", code) }
        // The API's "prompt" is its way to be told how names are spelled.
        if !vocabulary.isEmpty { field("prompt", vocabulary.prefix(100).joined(separator: ", ")) }
        body.append(Data("--\(boundary)--\r\n".utf8))
        request.httpBody = body
        return request
    }

    public static func cleanupRequest(_ config: CloudConfig, text: String, vocabulary: [String]) throws -> URLRequest {
        var request = try request(config, "/chat/completions")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var messages: [[String: String]] = [["role": "system", "content": Cleanup.system(vocabulary: vocabulary)]]
        for shot in Cleanup.shots {
            messages.append(["role": "user", "content": Cleanup.wrap(shot.heard)])
            messages.append(["role": "assistant", "content": shot.written])
        }
        messages.append(["role": "user", "content": Cleanup.wrap(text)])
        let payload: [String: Any] = ["model": config.cleanupModel.trimmingCharacters(in: .whitespaces), "messages": messages, "temperature": 0]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        return request
    }

    /// The API's own words for what went wrong, when it gave any.
    public static func failure(status: Int, body: Data) -> CloudError {
        var detail = String(decoding: body.prefix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            if let error = json["error"] as? [String: Any], let message = error["message"] as? String { detail = message }
            else if let message = json["message"] as? String { detail = message }
        }
        return CloudError("The API answered \(status)\(detail.isEmpty ? "." : ": \(detail)")")
    }

    public static func transcript(from body: Data) -> String {
        if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let text = json["text"] as? String {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // Some servers answer with the bare text whatever format was asked for.
        return String(decoding: body, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func cleaned(from body: Data) throws -> String {
        guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw CloudError("The API returned no text for the editing pass.")
        }
        return Cleanup.unwrap(content)
    }
}
