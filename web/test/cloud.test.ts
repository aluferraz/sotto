import { describe, expect, it } from 'vitest'
import { DEFAULTS, hotkeyNames, normalize, spellingHints, withHotkey } from '../src/core/settings'
import { decodeWav } from '../src/core/audio'
import { dictate, problem, type CloudConfig, type Http, type HttpRequest } from '../src/engine/cloud'

const config: CloudConfig = { baseUrl: 'https://api.example.com/v1/', apiKey: ' sk-test ', model: 'whisper-1', cleanupModel: '' }
const speech = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5) * 0.3)

function fake(answers: Record<string, { status: number; body: string }>) {
  const seen: HttpRequest[] = []
  const http: Http = async (request) => {
    seen.push(request)
    const path = Object.keys(answers).find((p) => request.url.endsWith(p))
    return path ? answers[path] : { status: 404, body: 'not found' }
  }
  return { http, seen }
}

const field = (request: HttpRequest, name: string) => {
  const part = request.form?.find((p) => p.name === name)
  return part && 'value' in part ? part.value : undefined
}

describe('OpenAI-compatible API', () => {
  it('sends the recording as a WAV file with the model, language and spelling hints', async () => {
    const { http, seen } = fake({ '/audio/transcriptions': { status: 200, body: '{"text":" Hello there. "}' } })
    const result = await dictate(http, config, speech, { language: 'Portuguese', smart: true, vocabulary: ['Sotto', 'LiteRT'] })
    expect(result.raw).toBe('Hello there.')
    expect(result.text).toBe('Hello there.')
    expect(result.audioSeconds).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://api.example.com/v1/audio/transcriptions')
    expect(seen[0].headers.Authorization).toBe('Bearer sk-test')
    expect(field(seen[0], 'model')).toBe('whisper-1')
    expect(field(seen[0], 'language')).toBe('pt')
    expect(field(seen[0], 'prompt')).toBe('Sotto, LiteRT')
    const file = seen[0].form!.find((p) => p.name === 'file')!
    expect('bytes' in file && decodeWav(file.bytes).length).toBe(16000)
  })

  it('omits the key and the language when there is none, and accepts a bare text answer', async () => {
    const { http, seen } = fake({ '/audio/transcriptions': { status: 200, body: 'Just text\n' } })
    const result = await dictate(http, { ...config, apiKey: '' }, speech, { language: '', smart: false, vocabulary: [] })
    expect(result.text).toBe('Just text')
    expect(seen[0].headers.Authorization).toBeUndefined()
    expect(field(seen[0], 'language')).toBeUndefined()
    expect(field(seen[0], 'prompt')).toBeUndefined()
  })

  it('runs the editing pass through chat completions when a chat model is set', async () => {
    const raw = 'um so I was thinking we could uh meet at 5 actually 6'
    const { http, seen } = fake({
      '/audio/transcriptions': { status: 200, body: JSON.stringify({ text: raw }) },
      '/chat/completions': { status: 200, body: JSON.stringify({ choices: [{ message: { content: '<transcript>So I was thinking we could meet at 6.</transcript>' } }] }) },
    })
    const result = await dictate(http, { ...config, cleanupModel: 'gpt-mini' }, speech, { language: 'English', smart: true, vocabulary: [] })
    expect(result.text).toBe('So I was thinking we could meet at 6.')
    expect(result.note).toBe('')
    const chat = seen[1].json as { model: string; messages: Array<{ role: string; content: string }>; temperature: number }
    expect(chat.model).toBe('gpt-mini')
    expect(chat.messages[0].role).toBe('system')
    expect(chat.messages.at(-1)).toEqual({ role: 'user', content: `<transcript>${raw}</transcript>` })
    expect(chat.temperature).toBe(0)
  })

  it('keeps the transcript when the editing pass answers the question or fails', async () => {
    const answers = {
      '/audio/transcriptions': { status: 200, body: JSON.stringify({ text: "What's the capital of France, again?" }) },
      '/chat/completions': { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'The capital of France is Paris.' } }] }) },
    }
    const cloud = { ...config, cleanupModel: 'gpt-mini' }
    const options = { language: 'English', smart: true, vocabulary: [] }
    const answered = await dictate(fake(answers).http, cloud, speech, options)
    expect(answered.text).toBe("What's the capital of France, again?")
    expect(answered.note).toContain('rejected')

    answers['/chat/completions'] = { status: 500, body: 'boom' }
    const failed = await dictate(fake(answers).http, cloud, speech, options)
    expect(failed.text).toBe("What's the capital of France, again?")
    expect(failed.note).toContain('cleanup failed')
  })

  it('reports the API error message', async () => {
    const { http } = fake({ '/audio/transcriptions': { status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' } })
    await expect(dictate(http, config, speech, { language: '', smart: false, vocabulary: [] }))
      .rejects.toThrow('The API answered 401: Incorrect API key provided')
  })

  it('explains an incomplete configuration', () => {
    expect(problem(config)).toBe('')
    expect(problem({ ...config, baseUrl: 'api.openai.com' })).toContain('API address')
    expect(problem({ ...config, model: ' ' })).toContain('model')
  })
})

describe('settings', () => {
  it('loads whatever was stored, falling back field by field', () => {
    expect(normalize(undefined)).toEqual(DEFAULTS)
    expect(normalize('nonsense')).toEqual(DEFAULTS)
    const s = normalize({
      language: 'Klingon', cleanup: 'light', tone: 'veryCasual', vocabulary: ['Sotto', 3, ' '],
      replacements: [{ heard: 'soto', written: 'Sotto' }, 'bad'], hotkeys: ['f13', 'ctrlRight', 'f13', 'nope'],
      engine: { kind: 'cloud', baseUrl: 'http://localhost:8000/v1' }, unloadAfterMinutes: -4,
    })
    expect(s.language).toBe('English')
    expect(s.cleanup).toBe('light')
    expect(s.tone).toBe('veryCasual')
    expect(s.vocabulary).toEqual(['Sotto'])
    expect(s.replacements).toEqual([{ heard: 'soto', written: 'Sotto' }, { heard: '', written: '' }])
    expect(s.hotkeys).toEqual(['ctrlRight', 'f13'])
    expect(s.engine).toEqual({ kind: 'cloud', baseUrl: 'http://localhost:8000/v1', model: DEFAULTS.engine.model, cleanupModel: '' })
    expect(s.unloadAfterMinutes).toBe(DEFAULTS.unloadAfterMinutes)
    expect(normalize({ language: '' }).language).toBe('')
    expect(normalize({ hotkeys: [] }).hotkeys).toEqual(['ctrlRight'])
  })

  it('keeps at least one dictation key and names them', () => {
    expect(withHotkey(['ctrlRight'], 'f13', true)).toEqual(['ctrlRight', 'f13'])
    expect(withHotkey(['ctrlRight', 'f13'], 'ctrlRight', false)).toEqual(['f13'])
    expect(withHotkey(['f13'], 'f13', false)).toEqual(['f13'])
    expect(hotkeyNames(['ctrlRight'])).toBe('Right Ctrl')
    expect(hotkeyNames(['ctrlRight', 'f13'])).toBe('Right Ctrl or F13')
    expect(hotkeyNames(['ctrlRight', 'altRight', 'f13'])).toBe('Right Ctrl, Right Alt or F13')
  })

  it('collects spelling hints without repeats', () => {
    expect(spellingHints({ vocabulary: ['Sotto', 'LiteRT'], replacements: [{ heard: 'soto', written: 'sotto' }, { heard: 'git hub', written: 'GitHub' }] }))
      .toEqual(['Sotto', 'LiteRT', 'GitHub'])
  })
})
