package dev.sotto.core

enum class CleanupLevel { VERBATIM, LIGHT, SMART }

enum class Tone { FORMAL, CASUAL, VERY_CASUAL }

data class Replacement(val heard: String, val written: String)

data class Snippet(val trigger: String, val expansion: String)

/**
 * Deterministic text work that runs after the model: personal replacements, filler removal,
 * snippets, tone, and fitting the text to what is already in the field. Everything here is a
 * pure function of its inputs. It mirrors Sources/SottoCore/PostProcessor.swift.
 */
object PostProcessor {
    data class Options(
        val cleanup: CleanupLevel,
        val tone: Tone,
        val replacements: List<Replacement> = emptyList(),
        val snippets: List<Snippet> = emptyList(),
    )

    private val insensitive = setOf(RegexOption.IGNORE_CASE)

    fun process(input: String, options: Options): String {
        var text = input.trim()
        if (text.isEmpty()) return ""

        for (r in options.replacements) {
            text = replacePhrase(r.heard, r.written, text)
        }
        if (options.cleanup != CleanupLevel.VERBATIM) {
            text = removeFillers(text)
        }
        if (text.isEmpty()) return ""

        val expanded = expandSnippets(text, options.snippets)
        if (expanded != text) {
            return expanded // a snippet is inserted exactly as the user saved it
        }
        return applyTone(text, options.tone)
    }

    // Replacements and snippets

    /**
     * Replaces [phrase] wherever it appears as whole words, ignoring case and tolerating any
     * run of whitespace between its words.
     */
    fun replacePhrase(phrase: String, replacement: String, text: String): String {
        val parts = phrase.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.map { Regex.escape(it) }
        if (parts.isEmpty()) return text
        val pattern = "(?<![\\p{L}\\p{N}])" + parts.joinToString("\\s+") + "(?![\\p{L}\\p{N}])"
        return Regex(pattern, insensitive).replace(text, Regex.escapeReplacement(replacement))
    }

    fun expandSnippets(text: String, snippets: List<Snippet>): String {
        var out = text
        for (s in snippets) {
            if (s.trigger.isBlank()) continue
            val replaced = replacePhrase(s.trigger, s.expansion, out)
            if (replaced == out) continue
            out = replaced
            // "My address." said on its own should become the address, not the address plus a period.
            for (mark in listOf(".", "!", "?", ",")) {
                if (out == s.expansion + mark) out = s.expansion
            }
        }
        return out
    }

    // Fillers

    private val fillerRegex = Regex(
        "(?<![\\p{L}\\p{N}'’])(?:u+h*m+|u+h+|e+r+m+|h+m{2,}|m+h+m+)(?![\\p{L}\\p{N}'’])[,.…]*\\s*",
        insensitive,
    )

    private val stutterRegex = Regex(
        "(?<![\\p{L}\\p{N}'’])(\\p{L}+)(?:[,]?\\s+\\1(?![\\p{L}\\p{N}'’]))+",
        insensitive,
    )

    /** Doubled words that are usually deliberate. */
    private val legitimateDoubles = setOf("that", "had", "bye", "no", "very", "really", "so", "ha", "knock", "tut")

    fun removeFillers(input: String): String {
        val withoutFillers = fillerRegex.replace(input, "")
        val removedFiller = withoutFillers != input

        // Collapse "the the" / "I, I" but leave deliberate doubles such as "had had".
        var text = stutterRegex.replace(withoutFillers) { match ->
            val first = match.groupValues[1]
            if (first.lowercase() in legitimateDoubles) match.value else first
        }

        text = tidySpacing(text)
        if (removedFiller) {
            text = capitalizeSentenceStarts(text)
        }
        return text
    }

    private val tidyRules = listOf(
        Regex("[ \\t]{2,}") to " ",           // runs of spaces
        Regex("[ \\t]+([,.;:!?])") to "$1",   // space before punctuation
        Regex("^[,;:.\\s]+") to "",           // punctuation left at the very start
        Regex("([,;:])[,;:.]+") to "$1",      // ", ," left behind by a removed word
    )

    fun tidySpacing(input: String): String {
        var text = input
        for ((regex, template) in tidyRules) {
            text = regex.replace(text, template)
        }
        return text.trim()
    }

    fun capitalizeSentenceStarts(input: String): String {
        val chars = input.toCharArray()
        var atStart = true
        for (i in chars.indices) {
            val c = chars[i]
            if (atStart && c.isLetter()) {
                chars[i] = c.uppercaseChar()
                atStart = false
            } else if (c == '.' || c == '!' || c == '?' || c == '\n') {
                // Only a terminator followed by whitespace starts a sentence ("3.5" and "e.g" do not).
                atStart = c == '\n' || (i + 1 < chars.size && chars[i + 1].isWhitespace())
            } else if (!c.isWhitespace() && atStart && !c.isLetter()) {
                atStart = c == '"' || c == '(' || c == '“'
            }
        }
        return String(chars)
    }

    // Tone

    /**
     * Tone only changes capitalization and the final period, never the words. Multi-line text
     * (lists, paragraphs) keeps its formal shape.
     */
    fun applyTone(text: String, tone: Tone): String {
        if (tone == Tone.FORMAL || text.contains('\n')) return text
        var out = text
        if (out.endsWith(".") && !out.endsWith("..")) {
            out = out.dropLast(1)
        }
        if (tone != Tone.VERY_CASUAL) return out

        val chars = out.toCharArray()
        var atStart = true
        var i = 0
        while (i < chars.size) {
            val c = chars[i]
            if (atStart && c.isLetter()) {
                var j = i
                while (j < chars.size && (chars[j].isLetter() || chars[j] == '\'' || chars[j] == '’')) j++
                val word = String(chars, i, j - i)
                // Keep "I", "I'm" and acronyms such as "API"; lowercase ordinary sentence starts.
                if (!isPronounI(word) && !isAcronym(word)) {
                    chars[i] = c.lowercaseChar()
                }
                atStart = false
            } else if (c == '.' || c == '!' || c == '?') {
                atStart = i + 1 < chars.size && chars[i + 1].isWhitespace()
            }
            i++
        }
        return String(chars)
    }

    private fun isPronounI(word: String) = word == "I" || word.startsWith("I'") || word.startsWith("I’")

    private fun isAcronym(word: String) = word.length > 1 && word == word.uppercase()

    // Fitting into the field

    /**
     * Adjusts [text] to continue from [before], the text left of the cursor. `null` means the
     * field could not be read, and the text is left alone.
     */
    fun fit(text: String, before: String?, protectedTerms: List<String> = emptyList()): String {
        if (before.isNullOrEmpty() || text.isEmpty()) return text
        val last = before.last()
        var out = text

        val lastVisible = before.trimEnd(' ', '\t', ' ').lastOrNull()
        if (lastVisible != null && (lastVisible.isLetterOrDigit() || lastVisible in ",;:")) {
            // Mid-sentence: continue in lower case unless the first word must keep its capital.
            val firstWord = out.takeWhile { it.isLetter() || it == '\'' || it == '’' }
            val isProtected = firstWord.isNotEmpty() &&
                protectedTerms.any { it.lowercase().startsWith(firstWord.lowercase()) }
            if (firstWord.isNotEmpty() && !isPronounI(firstWord) && !isAcronym(firstWord) && !isProtected) {
                out = out.first().lowercase() + out.drop(1)
            }
        }

        val opensGroup = last in "([{“\"'‘/-–—"
        if (!last.isWhitespace() && !opensGroup && out.first() !in ",.;:!?)]}") {
            out = " $out"
        }
        return out
    }
}
