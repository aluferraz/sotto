import Foundation
import SottoCore

/// Dictation through an OpenAI-compatible API, for those who prefer a hosted model: the
/// recording goes to `{base}/audio/transcriptions`, and the Smart pass, when a chat model is
/// named, to `{base}/chat/completions`. The same guard as the local engine's decides whether
/// the edited text can be trusted.
enum CloudEngine {
    /// Calls `completion` on the main queue.
    static func transcribe(
        samples: [Float],
        config: CloudConfig,
        language: String,
        smart: Bool,
        vocabulary: [String],
        session: URLSession = .shared,
        completion: @escaping (Result<Transcript, EngineError>) -> Void
    ) {
        Task {
            let result: Result<Transcript, EngineError>
            do {
                result = .success(try await run(samples: samples, config: config, language: language, smart: smart, vocabulary: vocabulary, session: session))
            } catch let error as CloudError {
                result = .failure(EngineError(description: error.description))
            } catch {
                result = .failure(EngineError(description: "The API could not be reached: \(error.localizedDescription)"))
            }
            await MainActor.run { completion(result) }
        }
    }

    static func run(
        samples: [Float], config: CloudConfig, language: String, smart: Bool, vocabulary: [String], session: URLSession = .shared
    ) async throws -> Transcript {
        let problem = CloudAPI.problem(config)
        guard problem.isEmpty else { throw CloudError(problem) }

        let started = Date()
        let request = try CloudAPI.transcriptionRequest(config, wav: CloudAPI.wav(samples), language: language, vocabulary: vocabulary)
        let raw = CloudAPI.transcript(from: try await send(request, session))
        let asrSeconds = Date().timeIntervalSince(started)

        var text = raw
        var note = ""
        var cleanupSeconds = 0.0
        let english = language.isEmpty || language == "English"
        if smart, english, !config.cleanupModel.trimmingCharacters(in: .whitespaces).isEmpty, Cleanup.words(raw).count >= 4 {
            let cleanupStarted = Date()
            do {
                let answer = try CloudAPI.cleaned(from: try await send(try CloudAPI.cleanupRequest(config, text: raw, vocabulary: vocabulary), session))
                let why = Cleanup.rejection(raw: raw, cleaned: answer, vocabulary: vocabulary)
                if why.isEmpty { text = answer } else { note = "cleanup rejected (\(why)); used the raw transcript" }
            } catch {
                // The words are already here; losing the polish is better than losing the dictation.
                note = "cleanup failed (\(error)); used the raw transcript"
            }
            cleanupSeconds = Date().timeIntervalSince(cleanupStarted)
        }
        return Transcript(
            raw: raw, text: text, audioSeconds: Double(samples.count) / 16_000,
            asrSeconds: asrSeconds, cleanupSeconds: cleanupSeconds, note: note)
    }

    private static func send(_ request: URLRequest, _ session: URLSession) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw CloudAPI.failure(status: status, body: data) }
        return data
    }
}
