import Foundation

struct Transcript {
    var raw: String
    var text: String
    var audioSeconds: Double
    var asrSeconds: Double
    var cleanupSeconds: Double
    var note: String
}

struct EngineError: Error, CustomStringConvertible {
    var description: String
}

/// Owns the Python sidecar that keeps LFM3-Audio loaded on the GPU through MLX,
/// and speaks its stdio protocol (see engine/server.py). Main thread only.
final class Engine: ObservableObject {
    enum State: Equatable {
        case stopped
        case loading(String)
        case ready(model: String, detail: String)
        case failed(String)

        var isUsable: Bool {
            switch self {
            case .loading, .ready: return true
            case .stopped, .failed: return false
            }
        }
    }

    @Published private(set) var state: State = .stopped

    private struct Pending {
        var onPartial: ((String) -> Void)?
        var completion: (Result<Transcript, EngineError>) -> Void
    }

    private var process: Process?
    private var input: FileHandle?
    private var readBuffer = Data()
    private var pending: [Int: Pending] = [:]
    private var nextID = 1
    private let writeQueue = DispatchQueue(label: "sotto.engine.write")

    static let logURL: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Sotto/engine.log")

    static let supportDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Sotto")

    // MARK: Locating the pieces

    /// The folder holding server.py when running from a checkout (`swift run`,
    /// or dist/Sotto.app inside the repository).
    private static func developmentEngineDirectory() -> URL? {
        var dir = Bundle.main.executableURL?.resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            guard let d = dir else { break }
            let candidate = d.appendingPathComponent("engine")
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("server.py").path) {
                return candidate
            }
            dir = d.deletingLastPathComponent()
        }
        return nil
    }

    static func locateServer() -> URL? {
        if let bundled = Bundle.main.url(forResource: "server", withExtension: "py") { return bundled }
        return developmentEngineDirectory()?.appendingPathComponent("server.py")
    }

    static func locatePython() -> URL? {
        var candidates: [URL] = []
        if let override = ProcessInfo.processInfo.environment["SOTTO_PYTHON"], !override.isEmpty {
            candidates.append(URL(fileURLWithPath: override))
        }
        candidates.append(supportDirectory.appendingPathComponent("venv/bin/python"))
        if let dev = developmentEngineDirectory() {
            candidates.append(dev.appendingPathComponent(".venv/bin/python"))
        }
        return candidates.first { url in
            // A directory also counts as "executable", so insist on a file.
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
                && !isDirectory.boolValue
                && FileManager.default.isExecutableFile(atPath: url.path)
        }
    }

    /// True when the weights are already on disk, so the engine can run with the network off.
    static func modelIsCached(_ model: String) -> Bool {
        let fm = FileManager.default
        if model.hasPrefix("/") || model.hasPrefix("~") {
            return fm.fileExists(atPath: (model as NSString).expandingTildeInPath)
        }
        let env = ProcessInfo.processInfo.environment
        let hub: URL
        if let cache = env["HF_HUB_CACHE"] {
            hub = URL(fileURLWithPath: cache)
        } else if let home = env["HF_HOME"] {
            hub = URL(fileURLWithPath: home).appendingPathComponent("hub")
        } else {
            hub = fm.homeDirectoryForCurrentUser.appendingPathComponent(".cache/huggingface/hub")
        }
        let snapshots = hub.appendingPathComponent("models--" + model.replacingOccurrences(of: "/", with: "--"))
            .appendingPathComponent("snapshots")
        let entries = (try? fm.contentsOfDirectory(atPath: snapshots.path)) ?? []
        return !entries.isEmpty
    }

    // MARK: Lifecycle

    func start(model: String) {
        stop()
        guard let python = Self.locatePython() else {
            state = .failed("Python environment not found. Run scripts/setup-engine.sh.")
            return
        }
        guard let server = Self.locateServer() else {
            state = .failed("engine/server.py not found.")
            return
        }

        let fm = FileManager.default
        try? fm.createDirectory(at: Self.logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: Self.logURL.path, contents: nil)

        let proc = Process()
        proc.executableURL = python
        proc.arguments = ["-u", server.path, "--model", model]
        var env = ProcessInfo.processInfo.environment
        env["PYTHONUNBUFFERED"] = "1"
        let cached = Self.modelIsCached(model)
        if cached {
            env["HF_HUB_OFFLINE"] = "1"  // weights are local: no network needed or wanted
        }
        proc.environment = env

        let inPipe = Pipe(), outPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = (try? FileHandle(forWritingTo: Self.logURL)) ?? FileHandle.nullDevice

        outPipe.fileHandleForReading.readabilityHandler = { [weak self, weak proc] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            DispatchQueue.main.async {
                guard let self, let proc, self.process === proc else { return }
                self.consume(data)
            }
        }
        proc.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, self.process === finished else { return }
                self.process = nil
                self.input = nil
                if case .failed = self.state {} else {
                    self.state = .failed("Engine exited (status \(finished.terminationStatus)). See \(Self.logURL.path).")
                }
                self.failAll("The engine stopped.")
            }
        }

        do {
            try proc.run()
        } catch {
            state = .failed("Could not start the engine: \(error.localizedDescription)")
            return
        }
        process = proc
        input = inPipe.fileHandleForWriting
        readBuffer.removeAll()
        state = .loading(cached ? "Loading model…" : "Downloading model (about 2 GB, first run only)…")
    }

    func stop() {
        if let proc = process {
            process = nil
            try? input?.close()
            input = nil
            proc.terminate()
        }
        failAll("The engine was restarted.")
        state = .stopped
    }

    // MARK: Requests

    func transcribe(
        samples: [Float],
        language: String,
        cleanup: String,
        vocabulary: [String],
        onPartial: ((String) -> Void)? = nil,
        completion: @escaping (Result<Transcript, EngineError>) -> Void
    ) {
        guard let input, process?.isRunning == true else {
            completion(.failure(EngineError(description: "The engine is not running.")))
            return
        }
        let id = nextID
        nextID += 1
        pending[id] = Pending(onPartial: onPartial, completion: completion)

        var header: [String: Any] = [
            "id": id,
            "op": "transcribe",
            "nbytes": samples.count * MemoryLayout<Float>.size,
            "cleanup": cleanup,
            "vocabulary": vocabulary,
            "stream": onPartial != nil,
        ]
        if !language.isEmpty {
            header["language"] = language
        }
        var message = (try? JSONSerialization.data(withJSONObject: header)) ?? Data()
        message.append(0x0A)
        samples.withUnsafeBufferPointer { message.append(Data(buffer: $0)) }

        writeQueue.async { [weak self] in
            do {
                try input.write(contentsOf: message)
            } catch {
                DispatchQueue.main.async {
                    self?.finish(id, .failure(EngineError(description: "Could not reach the engine.")))
                }
            }
        }
        // A long clip plus cleanup takes a few seconds at most; this only catches a hung engine.
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
            self?.finish(id, .failure(EngineError(description: "The engine did not answer in time.")))
        }
    }

    private func finish(_ id: Int, _ result: Result<Transcript, EngineError>) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.completion(result)
    }

    private func failAll(_ why: String) {
        let waiting = pending
        pending.removeAll()
        for entry in waiting.values {
            entry.completion(.failure(EngineError(description: why)))
        }
    }

    // MARK: Protocol

    private func consume(_ data: Data) {
        readBuffer.append(data)
        while let newline = readBuffer.firstIndex(of: 0x0A) {
            let line = readBuffer.subdata(in: readBuffer.startIndex..<newline)
            readBuffer.removeSubrange(readBuffer.startIndex...newline)
            guard !line.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let event = object["event"] as? String
            else { continue }
            handle(event: event, object)
        }
    }

    private func handle(event: String, _ msg: [String: Any]) {
        let id = msg["id"] as? Int
        switch event {
        case "ready":
            let model = msg["model"] as? String ?? ""
            let load = msg["load_s"] as? Double ?? 0
            let warm = msg["warmup_s"] as? Double ?? 0
            state = .ready(model: model, detail: String(format: "loaded in %.1f s on the GPU", load + warm))
        case "fatal":
            state = .failed(msg["message"] as? String ?? "The engine failed to start.")
        case "partial":
            if let id, let text = msg["text"] as? String {
                pending[id]?.onPartial?(text)
            }
        case "done":
            guard let id else { return }
            let timings = msg["timings"] as? [String: Any] ?? [:]
            finish(id, .success(Transcript(
                raw: msg["raw"] as? String ?? "",
                text: msg["text"] as? String ?? "",
                audioSeconds: timings["audio_s"] as? Double ?? 0,
                asrSeconds: timings["asr_s"] as? Double ?? 0,
                cleanupSeconds: timings["cleanup_s"] as? Double ?? 0,
                note: msg["note"] as? String ?? "")))
        case "error":
            guard let id else { return }
            finish(id, .failure(EngineError(description: msg["message"] as? String ?? "Unknown engine error.")))
        default:
            break
        }
    }
}
