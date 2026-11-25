import { encodeWav, SAMPLE_RATE } from '../core/audio'
import * as Cleanup from '../core/cleanup'
import { languageCode } from '../core/settings'
import type { DictationResult } from './lfm'

/**
 * Dictation through any service that speaks the OpenAI API: `POST {base}/audio/transcriptions`
 * for the speech, and optionally `POST {base}/chat/completions` for the Smart editing pass. For
 * people who would rather use a hosted model, or whose computer cannot run the local one.
 */
export interface CloudConfig {
  baseUrl: string
  apiKey: string
  model: string
  cleanupModel: string
}

export type FormPart =
  | { name: string; value: string }
  | { name: string; filename: string; type: string; bytes: Uint8Array }

export interface HttpRequest {
  url: string
  headers: Record<string, string>
  json?: unknown
  form?: FormPart[]
}

/** How requests leave: `fetch` in a browser, the main process in the Windows app (no CORS there). */
export type Http = (request: HttpRequest) => Promise<{ status: number; body: string }>

export const browserHttp: Http = async (request) => {
  let body: BodyInit
  const headers = { ...request.headers }
  if (request.form) {
    const form = new FormData()
    for (const part of request.form) {
      if ('value' in part) form.append(part.name, part.value)
      else form.append(part.name, new Blob([part.bytes as BlobPart], { type: part.type }), part.filename)
    }
    body = form
  } else {
    body = JSON.stringify(request.json)
    headers['Content-Type'] = 'application/json'
  }
  const response = await fetch(request.url, { method: 'POST', headers, body })
  return { status: response.status, body: await response.text() }
}

const endpoint = (config: CloudConfig, path: string) => config.baseUrl.trim().replace(/\/+$/, '') + path

const auth = (config: CloudConfig): Record<string, string> =>
  config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}

export function problem(config: CloudConfig): string {
  if (!/^https?:\/\/\S+$/i.test(config.baseUrl.trim())) return 'Enter the API address, for example https://api.openai.com/v1.'
  if (!config.model.trim()) return 'Enter the name of the transcription model.'
  return ''
}

function failure(status: number, body: string): Error {
  let detail = body.trim().slice(0, 300)
  try {
    const parsed = JSON.parse(body)
    detail = parsed?.error?.message ?? parsed?.message ?? detail
  } catch {
    // not JSON: use the text as it is
  }
  return new Error(`The API answered ${status}${detail ? `: ${detail}` : '.'}`)
}

export async function transcribe(
  http: Http, config: CloudConfig, samples: Float32Array, language: string, vocabulary: readonly string[],
): Promise<string> {
  const form: FormPart[] = [
    { name: 'file', filename: 'speech.wav', type: 'audio/wav', bytes: encodeWav(samples) },
    { name: 'model', value: config.model.trim() },
    { name: 'response_format', value: 'json' },
  ]
  const code = languageCode(language)
  if (code) form.push({ name: 'language', value: code })
  // The API's "prompt" is its way to be told how names are spelled.
  if (vocabulary.length) form.push({ name: 'prompt', value: vocabulary.slice(0, 100).join(', ') })
  const { status, body } = await http({ url: endpoint(config, '/audio/transcriptions'), headers: auth(config), form })
  if (status < 200 || status >= 300) throw failure(status, body)
  try {
    const parsed = JSON.parse(body)
    if (typeof parsed?.text === 'string') return parsed.text.trim()
  } catch {
    // Some servers answer with the bare text whatever format was asked for.
  }
  return body.trim()
}

export async function cleanup(http: Http, config: CloudConfig, text: string, vocabulary: readonly string[]): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: Cleanup.system(vocabulary) }]
  for (const [heard, written] of Cleanup.shots) {
    messages.push({ role: 'user', content: Cleanup.wrap(heard) }, { role: 'assistant', content: written })
  }
  messages.push({ role: 'user', content: Cleanup.wrap(text) })
  const { status, body } = await http({
    url: endpoint(config, '/chat/completions'),
    headers: auth(config),
    json: { model: config.cleanupModel.trim(), messages, temperature: 0 },
  })
  if (status < 200 || status >= 300) throw failure(status, body)
  const content = JSON.parse(body)?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('The API returned no text for the editing pass.')
  return Cleanup.unwrap(content)
}

/** The same pipeline as the local engine, with the same guard on the editing pass. */
export async function dictate(
  http: Http,
  config: CloudConfig,
  samples: Float32Array,
  options: { language: string; smart: boolean; vocabulary: readonly string[] },
): Promise<DictationResult> {
  const started = performance.now()
  const raw = await transcribe(http, config, samples, options.language, options.vocabulary)
  const asrMs = Math.round(performance.now() - started)
  let text = raw
  let note = ''
  let cleanupMs = 0
  const english = !options.language.trim() || options.language === 'English'
  if (options.smart && english && config.cleanupModel.trim() && Cleanup.words(raw).length >= 4) {
    const cleanupStarted = performance.now()
    try {
      const answer = await cleanup(http, config, raw, options.vocabulary)
      const why = Cleanup.rejection(raw, answer, options.vocabulary)
      if (why) note = `cleanup rejected (${why}); used the raw transcript`
      else text = answer
    } catch (error) {
      // The words are already here; losing the polish is better than losing the dictation.
      note = `cleanup failed (${error instanceof Error ? error.message : error}); used the raw transcript`
    }
    cleanupMs = Math.round(performance.now() - cleanupStarted)
  }
  return { raw, text, audioSeconds: samples.length / SAMPLE_RATE, asrMs, cleanupMs, note }
}
