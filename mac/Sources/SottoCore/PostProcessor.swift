import Foundation

/// Deterministic text work that runs after the model: personal replacements,
/// filler removal, snippets, tone, and fitting the text to what is already in
/// the field. Everything here is a pure function of its inputs.
public enum PostProcessor {
    public struct Options {
        public var cleanup: CleanupLevel
        public var tone: Tone
        public var replacements: [Replacement]
        public var snippets: [Snippet]

        public init(cleanup: CleanupLevel, tone: Tone, replacements: [Replacement] = [], snippets: [Snippet] = []) {
            self.cleanup = cleanup; self.tone = tone; self.replacements = replacements; self.snippets = snippets
        }
    }

    public static func process(_ input: String, options: Options) -> String {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "" }

        for r in options.replacements {
            text = replacePhrase(r.heard, with: r.written, in: text)
        }
        if options.cleanup != .verbatim {
            text = removeFillers(text)
        }
        guard !text.isEmpty else { return "" }

        let expanded = expandSnippets(text, snippets: options.snippets)
        if expanded != text {
            return expanded  // a snippet is inserted exactly as the user saved it
        }
        return applyTone(text, tone: options.tone)
    }

    // MARK: Replacements and snippets

    /// Replaces `phrase` wherever it appears as whole words, ignoring case and
    /// tolerating any run of whitespace between its words.
    static func replacePhrase(_ phrase: String, with replacement: String, in text: String) -> String {
        let parts = phrase.split(whereSeparator: \.isWhitespace).map { NSRegularExpression.escapedPattern(for: String($0)) }
        guard !parts.isEmpty else { return text }
        let pattern = "(?<![\\p{L}\\p{N}])" + parts.joined(separator: "\\s+") + "(?![\\p{L}\\p{N}])"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(
            in: text, range: range, withTemplate: NSRegularExpression.escapedTemplate(for: replacement))
    }

    static func expandSnippets(_ text: String, snippets: [Snippet]) -> String {
        var out = text
        for s in snippets where !s.trigger.trimmingCharacters(in: .whitespaces).isEmpty {
            let replaced = replacePhrase(s.trigger, with: s.expansion, in: out)
            guard replaced != out else { continue }
            out = replaced
            // "My address." said on its own should become the address, not the address plus a period.
            for mark in [".", "!", "?", ","] where out == s.expansion + mark {
                out = s.expansion
            }
        }
        return out
    }

    // MARK: Fillers

    private static let fillerRegex = try! NSRegularExpression(
        pattern: "(?<![\\p{L}\\p{N}'’])(?:u+h*m+|u+h+|e+r+m+|h+m{2,}|m+h+m+)(?![\\p{L}\\p{N}'’])[,.…]*\\s*",
        options: [.caseInsensitive])

    private static let stutterRegex = try! NSRegularExpression(
        pattern: "(?<![\\p{L}\\p{N}'’])(\\p{L}+)(?:[,]?\\s+\\1(?![\\p{L}\\p{N}'’]))+",
        options: [.caseInsensitive])

    /// Doubled words that are usually deliberate.
    private static let legitimateDoubles: Set<String> = ["that", "had", "bye", "no", "very", "really", "so", "ha", "knock", "tut"]

    static func removeFillers(_ input: String) -> String {
        var text = input
        var range = NSRange(text.startIndex..., in: text)
        let withoutFillers = fillerRegex.stringByReplacingMatches(in: text, range: range, withTemplate: "")
        let removedFiller = withoutFillers != text
        text = withoutFillers

        // Collapse "the the" / "I, I" but leave deliberate doubles such as "had had".
        range = NSRange(text.startIndex..., in: text)
        var result = ""
        var cursor = text.startIndex
        for match in stutterRegex.matches(in: text, range: range) {
            guard let whole = Range(match.range, in: text), let word = Range(match.range(at: 1), in: text) else { continue }
            result += text[cursor..<whole.lowerBound]
            let first = String(text[word])
            result += legitimateDoubles.contains(first.lowercased()) ? String(text[whole]) : first
            cursor = whole.upperBound
        }
        result += text[cursor...]
        text = result

        text = tidySpacing(text)
        if removedFiller {
            text = capitalizeSentenceStarts(text)
        }
        return text
    }

    static func tidySpacing(_ input: String) -> String {
        var text = input
        for (pattern, template) in [
            ("[ \\t]{2,}", " "),            // runs of spaces
            ("[ \\t]+([,.;:!?])", "$1"),    // space before punctuation
            ("^[,;:.\\s]+", ""),            // punctuation left at the very start
            ("([,;:])[,;:.]+", "$1"),       // ", ," left behind by a removed word
        ] {
            text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func capitalizeSentenceStarts(_ input: String) -> String {
        var chars = Array(input)
        var atStart = true
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if atStart, c.isLetter {
                chars[i] = Character(String(c).uppercased())
                atStart = false
            } else if c == "." || c == "!" || c == "?" || c == "\n" {
                // Only a terminator followed by whitespace starts a sentence ("3.5" and "e.g" do not).
                atStart = c == "\n" || (i + 1 < chars.count && chars[i + 1].isWhitespace)
            } else if !c.isWhitespace, atStart, !c.isLetter {
                atStart = c == "\"" || c == "(" || c == "“"
            }
            i += 1
        }
        return String(chars)
    }

    // MARK: Tone

    /// Tone only changes capitalization and the final period, never the words.
    /// Multi-line text (lists, paragraphs) keeps its formal shape.
    static func applyTone(_ text: String, tone: Tone) -> String {
        guard tone != .formal, !text.contains("\n") else { return text }
        var out = text
        if out.hasSuffix("."), !out.hasSuffix("..") {
            out.removeLast()
        }
        guard tone == .veryCasual else { return out }

        var chars = Array(out)
        var atStart = true
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if atStart, c.isLetter {
                var j = i
                while j < chars.count, chars[j].isLetter || chars[j] == "'" || chars[j] == "’" { j += 1 }
                let word = String(chars[i..<j])
                // Keep "I", "I'm" and acronyms such as "API"; lowercase ordinary sentence starts.
                let isI = word == "I" || word.hasPrefix("I'") || word.hasPrefix("I’")
                let isAcronym = word.count > 1 && word == word.uppercased()
                if !isI && !isAcronym {
                    chars[i] = Character(String(c).lowercased())
                }
                atStart = false
            } else if c == "." || c == "!" || c == "?" {
                atStart = i + 1 < chars.count && chars[i + 1].isWhitespace
            }
            i += 1
        }
        return String(chars)
    }

    // MARK: Fitting into the field

    /// Adjusts `text` to continue from `before`, the text left of the cursor.
    /// `nil` means the field could not be read, and the text is left alone.
    public static func fit(_ text: String, after before: String?, protectedTerms: [String] = []) -> String {
        guard let before, let last = before.last, !text.isEmpty else { return text }
        var out = text

        let trimmed = before.trimmingCharacters(in: .whitespaces)
        if let lastVisible = trimmed.last, lastVisible.isLetter || lastVisible.isNumber || ",;:".contains(lastVisible) {
            // Mid-sentence: continue in lower case unless the first word must keep its capital.
            let firstWord = String(out.prefix { $0.isLetter || $0 == "'" || $0 == "’" })
            let isI = firstWord == "I" || firstWord.hasPrefix("I'") || firstWord.hasPrefix("I’")
            let isAcronym = firstWord.count > 1 && firstWord == firstWord.uppercased()
            let isProtected = protectedTerms.contains { $0.lowercased().hasPrefix(firstWord.lowercased()) && !firstWord.isEmpty }
            if !firstWord.isEmpty, !isI, !isAcronym, !isProtected, let first = out.first {
                out.replaceSubrange(out.startIndex...out.startIndex, with: String(first).lowercased())
            }
        }

        let opensGroup = "([{“\"'‘/-–—".contains(last)
        if !last.isWhitespace, !opensGroup, let first = out.first, !",.;:!?)]}".contains(first) {
            out = " " + out
        }
        return out
    }
}
