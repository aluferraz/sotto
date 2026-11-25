import { app, BrowserWindow, clipboard } from 'electron'
import { mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { uIOhook, UiohookKey } from 'uiohook-napi'

/**
 * `Sotto --smoke-test=DIR --smoke-clip=CLIP.wav` checks the parts that only exist on a real
 * desktop: it presses the dictation key through the operating system, "speaks" CLIP through a
 * fake microphone, answers the transcription request from a stand-in API on this computer, and
 * reads back what was pasted into a text field. It also saves a screenshot of every screen.
 * Results go to DIR/smoke.json; the exit code is the number of failed checks.
 *
 * It runs with made-up content (the page's demo mode) and its own empty profile. With
 * `--smoke-download` it also downloads the real speech model into the app's storage and checks
 * it; when the machine has a graphics adapter that can run it, it then loads the model and
 * dictates CLIP with it, to a second field.
 */
interface Check { name: string; ok: boolean; detail: string; required: boolean }

interface Tools {
  keyListener: () => { ok: boolean; message: string }
  clipboardContents: () => Promise<Electron.ClipboardItem[] | undefined>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const SPOKEN = 'This sentence came from the stand-in API.'

export async function smokeTest(directory: string, window: BrowserWindow, tools: Tools): Promise<number> {
  mkdirSync(directory, { recursive: true })
  const checks: Check[] = []
  const record = (name: string, ok: boolean, detail = '', required = true) => {
    checks.push({ name, ok, detail, required })
    console.log(`${ok ? 'ok  ' : required ? 'FAIL' : 'note'} ${name}${detail ? `: ${detail}` : ''}`)
  }
  const js = <T>(code: string) => window.webContents.executeJavaScript(code, true) as Promise<T>
  const until = async (test: () => Promise<boolean>, seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) {
      if (await test()) return true
      await sleep(100)
    }
    return false
  }

  // A stand-in for an OpenAI-compatible API, to see exactly what the app sends.
  const received: Array<{ url: string; type: string; bytes: number; authorization: string }> = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received.push({
        url: request.url ?? '', type: request.headers['content-type'] ?? '',
        bytes: Buffer.concat(chunks).length, authorization: request.headers.authorization ?? '',
      })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ text: SPOKEN }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  let original: Electron.ClipboardItem[] | undefined

  const secret = `sk-smoke-${Date.now()}`
  const dictateThroughTheSystem = async () => {
    // Point the page at the stand-in API and make F13 the dictation key.
    await js(`sotto.settings.update((s) => ({ ...s, sounds: false, cleanup: 'light', hotkeys: ['f13'],
      engine: { kind: 'cloud', baseUrl: 'http://127.0.0.1:${port}/v1', model: 'stand-in', cleanupModel: '' } }))`)
    await js(`sotto.tab.set('dictionary')`)
    await sleep(300)
    await js(`document.querySelector('.add input').focus()`)
    const field = () => js<string>(`document.querySelector('.add input').value`)

    // The test uses the real clipboard; whatever was on it comes back at the end.
    original = await tools.clipboardContents()
    await clipboard.writeText('what was on the clipboard')

    // Press and hold F13 through the operating system, as a keyboard would.
    const clip = process.argv.find((a) => a.startsWith('--smoke-clip='))?.slice('--smoke-clip='.length)
    const header = clip ? readFileSync(clip).subarray(0, 44) : undefined
    const seconds = clip && header ? (statSync(clip).size - 44) / header.readUInt16LE(32) / header.readUInt32LE(24) : 3
    uIOhook.keyToggle(UiohookKey.F13, 'down')
    const heard = await until(() => js<boolean>(`sotto.dictation.phase.value === 'recording'`), 3)
    record('a key pressed anywhere starts dictation', heard, heard ? '' : 'the listener did not report the press', process.platform === 'win32')
    if (!heard) await js(`sotto.dictation.key('down')`)
    await sleep(Math.min(seconds, 15) * 1000 + 500)
    const levels = await js<number>(`sotto.dictation.levels.value.length`)
    record('the microphone delivers audio', levels > 10, `${levels} loudness readings`)
    uIOhook.keyToggle(UiohookKey.F13, 'up')
    if (!heard) await js(`sotto.dictation.key('up')`)

    const idle = await until(() => js<boolean>(`sotto.dictation.phase.value === 'idle'`), 30)
    const notice = await js<string>(`sotto.dictation.notice.value`)
    record('the dictation finishes', idle && !notice, notice)

    const request = received.find((r) => r.url === '/v1/audio/transcriptions')
    record('the recording reaches the API as a file', !!request && request.type.startsWith('multipart/form-data') && request.bytes > 30_000,
      request ? `${request.bytes} bytes` : 'no request arrived')
    record('the API key is sent with it', request?.authorization === `Bearer ${secret}`)

    const pasted = await until(async () => (await field()).includes(SPOKEN.slice(0, -1)), 5)
    record('the text is pasted into the field that has the keyboard', pasted, JSON.stringify(await field()), process.platform === 'win32')

    await sleep(1200)
    const restored = await clipboard.readText()
    record('the clipboard gets its content back', restored === 'what was on the clipboard', JSON.stringify(restored), process.platform === 'win32')

    const history = await js<string>(`sotto.history.value[0]?.text ?? ''`)
    record('the dictation is in the history', history === SPOKEN, history)
    writeFileSync(path.join(directory, 'windows-after-dictation.png'), (await window.webContents.capturePage()).toPNG())
    // The API settings, with OpenAI's public address in place of the stand-in's.
    await js(`sotto.settings.update((s) => ({ ...s, engine: { kind: 'cloud', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', cleanupModel: 'gpt-4o-mini' } }))`)
    await js(`sotto.tab.set('settings')`)
    await sleep(400)
    await js(`document.querySelector('h2 + .choice').scrollIntoView({ block: 'center' })`)
    await sleep(300)
    writeFileSync(path.join(directory, 'windows-api.png'), (await window.webContents.capturePage()).toPNG())
  }

  try {
    const loaded = await until(() => js<boolean>(`typeof sotto === 'object'`).catch(() => false), 30)
    record('the page loads inside the app', loaded)
    if (!loaded) return finish(directory, checks)

    record('the page reaches the app', await js<boolean>(`typeof sottoDesktop === 'object' && sottoDesktop.version === ${JSON.stringify(app.getVersion())}`))

    // The page's own verdict on whether this machine can run the model.
    const gpu = await js<{ ok: boolean; reason: string; name: string }>(`sotto.describeGpu()`)
      .catch((error) => ({ ok: false, reason: String(error), name: '' }))
    record('a graphics adapter that can run the on-device model', gpu.ok, gpu.ok ? gpu.name : `${gpu.name} ${gpu.reason}`.trim(), false)

    // `--smoke-no-os-input` leaves the keyboard, the clipboard and the window focus alone, for
    // running on a computer somebody is using.
    const osInput = !process.argv.includes('--smoke-no-os-input')
    if (osInput) {
      window.show()
      window.focus()
      app.focus({ steal: true })
    } else {
      window.showInactive()
    }
    await sleep(500)

    for (const tab of ['home', 'settings', 'dictionary', 'history']) {
      await js(`sotto.tab.set('${tab}')`)
      await sleep(350)
      writeFileSync(path.join(directory, `windows-${tab}.png`), (await window.webContents.capturePage()).toPNG())
    }
    record('screenshots saved', true, directory)

    await js(`sottoDesktop.setSecret('apiKey', '${secret}')`)
    const stored = readFileSync(path.join(app.getPath('userData'), 'secrets.json'), 'utf8')
    record('the API key is stored encrypted', (await js<string>(`sottoDesktop.getSecret('apiKey')`)) === secret && !stored.includes(secret))
    await js(`sotto.apiKey.set('${secret}')`)

    const state = tools.keyListener()
    record('the system-wide key listener starts', state.ok, state.message)
    if (osInput) await dictateThroughTheSystem()


    if (process.argv.includes('--smoke-download')) await onDevice(record, until, gpu.ok)
  } catch (error) {
    record('the smoke test ran to the end', false, String(error))
  } finally {
    server.close()
    if (original?.length) await clipboard.write(original).catch(() => undefined)
  }
  return finish(directory, checks)
}

/**
 * The on-device engine for real, in a second window that is not in demo mode: download from
 * Hugging Face, checksum, and, where the graphics adapter allows, load and transcribe.
 */
async function onDevice(
  record: (name: string, ok: boolean, detail?: string, required?: boolean) => void,
  until: (test: () => Promise<boolean>, seconds: number) => Promise<boolean>,
  canRun: boolean,
): Promise<void> {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } })
  await window.loadURL('app://sotto/index.html')
  const js = <T>(code: string) => window.webContents.executeJavaScript(code, true) as Promise<T>
  const kind = () => js<string>(`sotto.engine.state.value.kind`)
  await until(async () => (await kind()) !== 'checking', 20)

  const started = Date.now()
  void js(`sotto.engine.download()`)
  let last = ''
  await until(async () => {
    const state = await js<{ kind: string; bytes?: number }>(`sotto.engine.state.value`)
    const line = state.kind === 'downloading' ? `${Math.round((state.bytes ?? 0) / 1e8) / 10} GB` : state.kind
    if (line !== last) console.log(`     download: ${(last = line)}`)
    return state.kind !== 'downloading' && state.kind !== 'checking' && state.kind !== 'absent'
  }, 1500)
  // Asked of the storage itself: how many of the five files are there and passed their checksum.
  // (On a machine without a graphics card the page then fails to load the model, which is expected.)
  const verified = await js<number>(`(async () => {
    const root = await navigator.storage.getDirectory()
    for await (const [name, handle] of root.entries()) {
      if (name.startsWith('sotto-model-')) return JSON.parse(await (await (await handle.getFileHandle('verified.json')).getFile()).text()).length
    }
    return 0
  })()`).catch(() => 0)
  const downloaded = verified === 5
  record('the speech model downloads and passes its checksums', downloaded, `${verified} of 5 files in ${Math.round((Date.now() - started) / 1000)} s`)
  if (!downloaded || !canRun) {
    if (!canRun) record('the speech model runs on this machine', false, 'no graphics adapter that can run it here', false)
    window.destroy()
    return
  }

  void js(`sotto.engine.warm()`)
  const ready = await until(async () => ['ready', 'failed'].includes(await kind()), 300)
  const state = await js<{ kind: string; gpu?: string; loadMs?: number; message?: string }>(`sotto.engine.state.value`)
  record('the speech model loads on the graphics adapter', ready && state.kind === 'ready', state.kind === 'ready' ? `${state.loadMs} ms on ${state.gpu}` : String(state.message))
  if (state.kind === 'ready') {
    // A second of a 220 Hz tone with a rising and falling volume: enough to see the engine answer.
    const answer = await js<{ raw: string; asrMs: number }>(`(async () => {
      const samples = Float32Array.from({ length: 32000 }, (_, i) => Math.sin(i * 2 * Math.PI * 220 / 16000) * 0.3 * Math.sin(i * Math.PI / 32000))
      return sotto.engine.dictate(samples, () => {})
    })()`)
    record('the speech model answers', typeof answer.raw === 'string', `${answer.asrMs} ms, heard ${JSON.stringify(answer.raw)}`)
  }
  window.destroy()
}

function finish(directory: string, checks: Check[]): number {
  const failures = checks.filter((c) => !c.ok && c.required).length
  writeFileSync(path.join(directory, 'smoke.json'), JSON.stringify({ platform: process.platform, arch: process.arch, failures, checks }, null, 2))
  console.log(failures === 0 ? 'smoke test passed' : `smoke test: ${failures} failed`)
  return failures
}
