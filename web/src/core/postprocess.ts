/**
 * Deterministic text work that runs after the model: personal replacements, filler removal,
 * snippets, tone, and fitting the text to what is already in the field. Everything here is a
 * pure function of its inputs, and mirrors the Swift and Kotlin versions rule for rule.
 */
export type CleanupLevel = 'verbatim' | 'light' | 'smart'
export type Tone = 'formal' | 'casual' | 'veryCasual'

export interface Replacement { heard: string; written: string }
export interface Snippet { trigger: string; expansion: string }

export interface Options {
  cleanup: CleanupLevel
  tone: Tone
  replacements?: readonly Replacement[]
  snippets?: readonly Snippet[]
}

export function process(input: string, options: Options): string {
  let text = input.trim()
  if (!text) return ''
  for (const r of options.replacements ?? []) text = replacePhrase(r.heard, r.written, text)
  if (options.cleanup !== 'verbatim') text = removeFillers(text)
  if (!text) return ''
  const expanded = expandSnippets(text, options.snippets ?? [])
  if (expanded !== text) return expanded // a snippet is inserted exactly as the user saved it
  return applyTone(text, options.tone)
}

// Replacements and snippets

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replaces `phrase` wherever it appears as whole words, ignoring case and tolerating any run of
 * whitespace between its words.
 */
export function replacePhrase(phrase: string, replacement: string, text: string): string {
  const parts = phrase.trim().split(/\s+/).filter(Boolean).map(escapeRegex)
  if (parts.length === 0) return text
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu')
  return text.replace(pattern, () => replacement)
}

export function expandSnippets(text: string, snippets: readonly Snippet[]): string {
  let out = text
  for (const s of snippets) {
    if (!s.trigger.trim()) continue
    const replaced = replacePhrase(s.trigger, s.expansion, out)
    if (replaced === out) continue
    out = replaced
    // "My address." said on its own should become the address, not the address plus a period.
    for (const mark of ['.', '!', '?', ',']) {
      if (out === s.expansion + mark) out = s.expansion
    }
  }
  return out
}

// Fillers

const FILLER = /(?<![\p{L}\p{N}'’])(?:u+h*m+|u+h+|e+r+m+|h+m{2,}|m+h+m+)(?![\p{L}\p{N}'’])[,.…]*\s*/giu
const STUTTER = /(?<![\p{L}\p{N}'’])(\p{L}+)(?:[,]?\s+\1(?![\p{L}\p{N}'’]))+/giu

/** Doubled words that are usually deliberate. */
const LEGITIMATE_DOUBLES = new Set(['that', 'had', 'bye', 'no', 'very', 'really', 'so', 'ha', 'knock', 'tut'])

export function removeFillers(input: string): string {
  const withoutFillers = input.replace(FILLER, '')
  const removedFiller = withoutFillers !== input
  // Collapse "the the" / "I, I" but leave deliberate doubles such as "had had".
  let text = withoutFillers.replace(STUTTER, (match, first: string) =>
    LEGITIMATE_DOUBLES.has(first.toLowerCase()) ? match : first)
  text = tidySpacing(text)
  if (removedFiller) text = capitalizeSentenceStarts(text)
  return text
}

const TIDY: ReadonlyArray<readonly [RegExp, string]> = [
  [/[ \t]{2,}/g, ' '],          // runs of spaces
  [/[ \t]+([,.;:!?])/g, '$1'],  // space before punctuation
  [/^[,;:.\s]+/, ''],           // punctuation left at the very start
  [/([,;:])[,;:.]+/g, '$1'],    // ", ," left behind by a removed word
]

export function tidySpacing(input: string): string {
  let text = input
  for (const [regex, template] of TIDY) text = text.replace(regex, template)
  return text.trim()
}

const isLetter = (c: string) => /\p{L}/u.test(c)
const isSpace = (c: string) => /\s/.test(c)

export function capitalizeSentenceStarts(input: string): string {
  const chars = [...input]
  let atStart = true
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (atStart && isLetter(c)) {
      chars[i] = c.toUpperCase()
      atStart = false
    } else if (c === '.' || c === '!' || c === '?' || c === '\n') {
      // Only a terminator followed by whitespace starts a sentence ("3.5" and "e.g" do not).
      atStart = c === '\n' || (i + 1 < chars.length && isSpace(chars[i + 1]))
    } else if (!isSpace(c) && atStart && !isLetter(c)) {
      atStart = c === '"' || c === '(' || c === '“'
    }
  }
  return chars.join('')
}

// Tone

const isPronounI = (word: string) => word === 'I' || word.startsWith("I'") || word.startsWith('I’')
const isAcronym = (word: string) => word.length > 1 && word === word.toUpperCase()

/**
 * Tone only changes capitalization and the final period, never the words. Multi-line text
 * (lists, paragraphs) keeps its formal shape.
 */
export function applyTone(text: string, tone: Tone): string {
  if (tone === 'formal' || text.includes('\n')) return text
  let out = text
  if (out.endsWith('.') && !out.endsWith('..')) out = out.slice(0, -1)
  if (tone !== 'veryCasual') return out

  const chars = [...out]
  let atStart = true
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (atStart && isLetter(c)) {
      let j = i
      while (j < chars.length && (isLetter(chars[j]) || chars[j] === "'" || chars[j] === '’')) j++
      const word = chars.slice(i, j).join('')
      // Keep "I", "I'm" and acronyms such as "API"; lowercase ordinary sentence starts.
      if (!isPronounI(word) && !isAcronym(word)) chars[i] = c.toLowerCase()
      atStart = false
    } else if (c === '.' || c === '!' || c === '?') {
      atStart = i + 1 < chars.length && isSpace(chars[i + 1])
    }
  }
  return chars.join('')
}

// Fitting into the field

/**
 * Adjusts `text` to continue from `before`, the text left of the cursor. `null` means the field
 * could not be read, and the text is left alone.
 */
export function fit(text: string, before: string | null | undefined, protectedTerms: readonly string[] = []): string {
  if (!before || !text) return text
  const last = before[before.length - 1]
  let out = text

  const visible = before.replace(/[ \t ]+$/, '')
  const lastVisible = visible[visible.length - 1]
  if (lastVisible !== undefined && (/[\p{L}\p{N}]/u.test(lastVisible) || ',;:'.includes(lastVisible))) {
    // Mid-sentence: continue in lower case unless the first word must keep its capital.
    const firstWord = out.match(/^[\p{L}'’]*/u)?.[0] ?? ''
    const isProtected = firstWord.length > 0 &&
      protectedTerms.some((term) => term.toLowerCase().startsWith(firstWord.toLowerCase()))
    if (firstWord && !isPronounI(firstWord) && !isAcronym(firstWord) && !isProtected) {
      out = out[0].toLowerCase() + out.slice(1)
    }
  }

  const opensGroup = '([{“"\'‘/-–—'.includes(last)
  if (!isSpace(last) && !opensGroup && !',.;:!?)]}'.includes(out[0])) out = ` ${out}`
  return out
}
