/**
 * Drives the real page in a hidden Electron window (Chromium, so WebGPU).
 *
 *   electron test/run-app.cjs --shots DIR                 screenshots of every screen, with made-up content
 *   electron test/run-app.cjs --e2e MODEL_DIR CLIP.wav    the whole path: download into the browser's storage,
 *                                                         load, "speak" CLIP through a fake microphone, read the text
 *   electron test/run-app.cjs --e2e - CLIP.wav --url URL  the same against a published copy of the page, which
 *                                                         then fetches the model from Hugging Face like any visitor
 *
 * CLIP must be 16-bit PCM. MODEL_DIR holds the five model files (see src/engine/modelStore.ts).
 */
const { app, BrowserWindow, protocol, net, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const args = process.argv.slice(2)
const dist = path.join(__dirname, '..', 'dist')
const shots = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : ''
const e2e = args.includes('--e2e')
const modelDir = e2e ? path.resolve(args[args.indexOf('--e2e') + 1]) : ''
const clip = e2e ? path.resolve(args[args.indexOf('--e2e') + 2]) : ''
const site = args.includes('--url') ? args[args.indexOf('--url') + 1] : ''

app.setPath('userData', path.join(os.homedir(), '.cache', site ? 'sotto-web-test-profile-site' : 'sotto-web-test-profile'))
if (e2e) {
  // The audio process may only read the fake microphone's file without its sandbox.
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${clip}%noloop`)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

// Windows come and go during the run; the script decides when to quit.
app.on('window-all-closed', () => {})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const name = decodeURIComponent(new URL(request.url).pathname)
    const file = name.startsWith('/model/') ? path.join(modelDir, name.slice(7)) : path.join(dist, name === '/' ? 'index.html' : name)
    return net.fetch(pathToFileURL(file).toString(), { headers: request.headers })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, allow) => allow(true))
  session.defaultSession.setPermissionCheckHandler(() => true)

  let failed = false
  const open = async (query, width = 860, height = 980) => {
    const window = new BrowserWindow({ show: false, width, height, webPreferences: { backgroundThrottling: false } })
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.error(`[page] ${event.message}`)
    })
    await window.loadURL(site && query === '' ? site : `app://sotto/index.html${query}`)
    return window
  }

  try {
    if (shots) {
      fs.mkdirSync(shots, { recursive: true })
      const take = async (name, query, prepare, height) => {
        const window = await open(query, 860, height)
        if (prepare) await window.webContents.executeJavaScript(prepare, true)
        await sleep(400)
        fs.writeFileSync(path.join(shots, `${name}.png`), (await window.webContents.capturePage()).toPNG())
        window.destroy()
        console.log('wrote', name)
      }
      const listening = `sotto.dictation.phase.set('handsFree'); sotto.dictation.levels.set(Array.from({length: 28}, (_, i) => 0.25 + 0.6 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.37))))`
      for (const theme of ['light', 'dark']) {
        await take(`home-${theme}`, `?demo&theme=${theme}`, '', 900)
        await take(`listening-${theme}`, `?demo&theme=${theme}`, listening, 900)
        await take(`settings-${theme}`, `?demo&theme=${theme}&tab=settings`, '', 1180)
        await take(`dictionary-${theme}`, `?demo&theme=${theme}&tab=dictionary`, '', 900)
        await take(`history-${theme}`, `?demo&theme=${theme}&tab=history`, '', 760)
      }
    }

    if (e2e) {
      const window = await open(site ? '' : '?model=app://sotto/model/')
      const js = (code) => window.webContents.executeJavaScript(code, true)
      const state = () => js('JSON.stringify(sotto.engine.state.value)').then(JSON.parse)
      const until = async (what, test, seconds) => {
        for (let i = 0; i < seconds * 4; i++) {
          const s = await state()
          if (test(s)) return s
          if (s.kind === 'failed' || s.kind === 'unsupported') throw new Error(`${what}: ${JSON.stringify(s)}`)
          await sleep(250)
        }
        throw new Error(`${what}: timed out at ${JSON.stringify(await state())}`)
      }
      console.log('microphones:', JSON.stringify(await js(`navigator.mediaDevices.enumerateDevices().then((all) => all.filter((d) => d.kind === 'audioinput').map((d) => d.label))`)))

      let s = await until('first state', (x) => x.kind !== 'checking', 20)
      console.log('start:', JSON.stringify(s))
      if (s.kind === 'absent') {
        const started = Date.now()
        js('sotto.engine.download()')
        await until('download', (x) => x.kind === 'resting' || x.kind === 'loading' || x.kind === 'ready', 600)
        console.log(`downloaded and verified in ${((Date.now() - started) / 1000).toFixed(1)} s`)
      }
      js('sotto.engine.warm()')
      s = await until('load', (x) => x.kind === 'ready', 120)
      console.log('ready:', JSON.stringify(s))

      // Hold the key for the length of the clip, as a person would.
      const header = fs.readFileSync(clip).subarray(0, 44)
      const seconds = (fs.statSync(clip).size - 44) / header.readUInt16LE(32) / header.readUInt32LE(24)
      await js(`sotto.dictation.key('down')`)
      await sleep(seconds * 1000 + 600)
      const levels = await js('sotto.dictation.levels.value.length')
      const awakeDuring = await js('sotto.dictation.keepingAwake')
      await js(`sotto.dictation.key('up')`)
      for (let i = 0; i < 120 && (await js('sotto.dictation.phase.value')) !== 'idle'; i++) await sleep(250)
      const text = await js('sotto.pad.value')
      const notice = await js('sotto.dictation.notice.value')
      const entry = await js('JSON.stringify(sotto.history.value[0] ?? null)')
      const awakeAfter = await js('sotto.dictation.keepingAwake')
      console.log(`level updates while recording: ${levels}`)
      console.log(`screen kept awake: ${awakeDuring} while recording, ${awakeAfter} afterwards`)
      if (!awakeDuring || awakeAfter) failed = true
      console.log(`typed: ${JSON.stringify(text)}`)
      console.log(`notice: ${JSON.stringify(notice)}  history: ${entry}`)

      // A chosen microphone records; one that is not connected falls back to the default.
      for (const [what, pick] of [['a chosen microphone', `all.find((d) => d.label === 'Fake Audio Input 2').deviceId`], ['an unplugged microphone', `'no-such-device'`]]) {
        await js(`navigator.mediaDevices.enumerateDevices().then((all) => sotto.settings.update((s) => ({ ...s, microphoneId: ${pick} })))`)
        await js(`sotto.dictation.key('down')`)
        await sleep(1500)
        const heard = await js('sotto.dictation.levels.value.length')
        const phase = await js('sotto.dictation.phase.value')
        await js(`sotto.dictation.key('escape')`)
        await sleep(300)
        console.log(`${what}: ${phase}, ${heard} level updates`)
        if (heard < 10) failed = true
      }
      await js(`sotto.settings.update((s) => ({ ...s, microphoneId: '' }))`)

      if (shots) fs.writeFileSync(path.join(shots, 'e2e.png'), (await window.webContents.capturePage()).toPNG())
    }
  } catch (error) {
    console.error('FAILED', error)
    failed = true
  }
  app.exit(failed ? 1 : 0)
})
