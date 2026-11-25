import {
  app, BrowserWindow, clipboard, ClipboardItem, ipcMain, Menu, nativeImage, protocol, safeStorage, screen, session, Tray,
  type NativeImage,
} from 'electron'
import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { smokeTest } from './smoke'

/**
 * Sotto for Windows. The interface and the speech engine are the web app (../web), running in
 * a window of this app; this file adds what a web page cannot do: hear a key in every app, type
 * into other apps, live in the tray, and show a small indicator above everything else.
 */
type Phase = 'idle' | 'recording' | 'handsFree' | 'processing'

const ORIGIN = 'app://sotto'
const WEB = path.join(__dirname, '..', 'web')
const ASSETS = path.join(__dirname, '..', 'assets')

/** The dictation keys the page offers (web/src/core/settings.ts), as system key codes. */
const KEYCODES: Record<string, number> = {
  ctrlRight: UiohookKey.CtrlRight,
  altRight: UiohookKey.AltRight,
  shiftRight: UiohookKey.ShiftRight,
  f13: UiohookKey.F13,
  f14: UiohookKey.F14,
  f15: UiohookKey.F15,
  f16: UiohookKey.F16,
}

const smokeDirectory = process.argv.find((a) => a.startsWith('--smoke-test='))?.slice('--smoke-test='.length)
const startHidden = process.argv.includes('--hidden')

let mainWindow: BrowserWindow | undefined
let pill: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let phase: Phase = 'idle'
let hotkeys = new Set<number>([UiohookKey.CtrlRight])
/** The dictation key that is physically down, if any. */
let held: number | undefined
let listener: { ok: boolean; message: string } = { ok: false, message: 'The key listener has not started.' }
let pillTimer: ReturnType<typeof setTimeout> | undefined

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

if (smokeDirectory) {
  // The test speaks through a fake microphone, which the audio process must be allowed to read.
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  const clip = process.argv.find((a) => a.startsWith('--smoke-clip='))?.slice('--smoke-clip='.length)
  if (clip) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${clip}%noloop`)
  app.setPath('userData', path.join(app.getPath('temp'), `sotto-smoke-${process.pid}`))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
  app.whenReady().then(start)
}

// Closing the window leaves Sotto in the tray, where it belongs.
app.on('window-all-closed', () => {})
app.on('before-quit', () => {
  quitting = true
  try {
    uIOhook.stop()
  } catch {
    // It may never have started.
  }
})

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json',
}

/**
 * What the page may load: itself, and the model from the network. Requests to the user's own
 * API go through this process (sotto:http), not through the page.
 */
const POLICY = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "worker-src 'self' blob:", "connect-src 'self' https: blob: data:",
].join('; ')

async function serve(request: Request): Promise<Response> {
  const name = decodeURIComponent(new URL(request.url).pathname)
  const file = path.normalize(path.join(WEB, name === '/' ? 'index.html' : name))
  if (!file.startsWith(WEB)) return new Response('Not found', { status: 404 })
  try {
    const body = await fs.readFile(file)
    return new Response(new Uint8Array(body), {
      headers: { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': POLICY },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

async function start(): Promise<void> {
  protocol.handle('app', serve)

  // The page may use the microphone; nothing else is ever asked for.
  session.defaultSession.setPermissionRequestHandler((contents, permission, allow) => {
    allow(permission === 'media' && contents.getURL().startsWith(ORIGIN))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) =>
    permission === 'media' && origin.startsWith(ORIGIN))

  registerIpc()
  startKeyListener()
  createTray()
  createMainWindow()
  createPill()

  if (smokeDirectory) {
    const failures = await smokeTest(smokeDirectory, mainWindow!, { keyListener: () => listener, clipboardContents })
    app.exit(failures === 0 ? 0 : 1)
  }
}

// Windows

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 860,
    height: 820,
    minWidth: 560,
    minHeight: 520,
    show: false,
    title: 'Sotto',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#131218',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The engine and the recorder keep working while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  })
  window.removeMenu()
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window.hide()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) event.preventDefault()
  })
  window.once('ready-to-show', () => {
    if (!startHidden) window.show()
  })
  void window.loadURL(`${ORIGIN}/index.html${smokeDirectory ? '?demo' : ''}`)
  mainWindow = window
}

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** The floating indicator: small, above everything, and never taking the keyboard. */
function createPill(): void {
  pill = new BrowserWindow({
    width: 172,
    height: 48,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  pill.setAlwaysOnTop(true, 'screen-saver')
  pill.setIgnoreMouseEvents(true)
  void pill.loadURL(`${ORIGIN}/pill.html`)
}

function setPhase(next: Phase): void {
  phase = next
  tray?.setImage(trayImage(next))
  tray?.setToolTip(next === 'idle' ? 'Sotto' : next === 'processing' ? 'Sotto is writing' : 'Sotto is listening')
  if (!pill) return
  clearTimeout(pillTimer)
  if (next === 'idle') {
    // Leave a moment for a closing message ("Didn't hear anything") to be read.
    pillTimer = setTimeout(() => pill?.hide(), 1400)
    return
  }
  if (!pill.isVisible()) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const [width, height] = pill.getSize()
    pill.setPosition(Math.round(area.x + (area.width - width) / 2), Math.round(area.y + area.height - height - 28))
    pill.showInactive()
  }
}

// Tray

function trayImage(current: Phase): NativeImage {
  const name = current === 'idle' ? 'tray.png' : 'tray-active.png'
  return nativeImage.createFromPath(path.join(ASSETS, name))
}

function createTray(): void {
  tray = new Tray(trayImage('idle'))
  tray.setToolTip('Sotto')
  const command = (name: string) => () => {
    if (name !== 'copy-last') showMainWindow()
    mainWindow?.webContents.send('sotto:command', name)
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Sotto', click: command('home') },
    { label: 'Settings', click: command('settings') },
    { label: 'History', click: command('history') },
    { type: 'separator' },
    { label: 'Copy the last dictation', click: command('copy-last') },
    { type: 'separator' },
    { label: 'Quit Sotto', click: () => app.quit() },
  ]))
  tray.on('click', showMainWindow)
}

// The dictation key, in every app

function startKeyListener(): void {
  const send = (event: 'down' | 'up' | 'escape' | 'other') => mainWindow?.webContents.send('sotto:key', event)
  uIOhook.on('keydown', (event) => {
    if (hotkeys.has(event.keycode)) {
      // Holding a key repeats it; only the first press counts.
      if (held === undefined) {
        held = event.keycode
        send('down')
      }
    } else if (event.keycode === UiohookKey.Escape) {
      // Escape only matters while Sotto is doing something; otherwise it belongs to the app in front.
      if (phase !== 'idle') send('escape')
    } else if (held !== undefined) {
      // Another key during a hold: the user is typing a shortcut, not dictating.
      send('other')
    }
  })
  uIOhook.on('keyup', (event) => {
    if (event.keycode === held) {
      held = undefined
      send('up')
    }
  })
  try {
    uIOhook.start()
    listener = { ok: true, message: '' }
  } catch (error) {
    listener = { ok: false, message: `Sotto could not listen for the dictation key: ${error instanceof Error ? error.message : error}` }
  }
}

// Typing into other apps

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Types `text` into the app that has the keyboard: the text goes on the clipboard, Ctrl+V is
 * pressed, and the clipboard gets its previous content back.
 */
async function paste(text: string, restoreClipboard: boolean): Promise<void> {
  const previous = restoreClipboard ? await clipboardContents() : undefined
  await clipboard.writeText(text)
  // A dictation key still held down would turn Ctrl+V into another shortcut.
  for (let waited = 0; held !== undefined && waited < 2000; waited += 20) await sleep(20)
  await sleep(40)
  uIOhook.keyTap(UiohookKey.V, [process.platform === 'darwin' ? UiohookKey.Meta : UiohookKey.Ctrl])
  if (!previous) return
  setTimeout(async () => {
    try {
      // Only if the clipboard still holds the dictation: the user may have copied something since.
      if ((await clipboard.readText()) !== text) return
      if (previous.length) await clipboard.write(previous)
      else clipboard.clear()
    } catch {
      // The dictation stays on the clipboard; nothing is lost.
    }
  }, 700)
}

/** Everything on the clipboard, in every format it is offered in, to put back later. */
async function clipboardContents(): Promise<ClipboardItem[] | undefined> {
  try {
    const saved: ClipboardItem[] = []
    for (const item of await clipboard.read()) {
      const parts: Record<string, Blob | Electron.ClipboardBookmark> = {}
      for (const type of item.types) parts[type] = await item.getType(type)
      if (Object.keys(parts).length) saved.push(new ClipboardItem(parts))
    }
    return saved
  } catch {
    return undefined
  }
}

// Secrets: the API key, encrypted with the user's Windows account (DPAPI)

const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json')

function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(secretsFile(), 'utf8'))
  } catch {
    return {}
  }
}

async function getSecret(name: string): Promise<string> {
  const stored = readSecrets()[name]
  if (!stored || !(await safeStorage.isAsyncEncryptionAvailable())) return ''
  try {
    return (await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'))).result
  } catch {
    return ''
  }
}

async function setSecret(name: string, value: string): Promise<void> {
  // Without encryption the key is kept for this session only, never written in the clear.
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return
  const secrets = readSecrets()
  if (value) secrets[name] = (await safeStorage.encryptStringAsync(value)).toString('base64')
  else delete secrets[name]
  writeFileSync(secretsFile(), JSON.stringify(secrets), { mode: 0o600 })
}

// Requests to the user's API

interface HttpRequest {
  url: string
  headers: Record<string, string>
  json?: unknown
  form?: Array<{ name: string; value: string } | { name: string; filename: string; type: string; bytes: Uint8Array }>
}

async function http(request: HttpRequest): Promise<{ status: number; body: string }> {
  if (!/^https?:\/\//i.test(request.url)) throw new Error('The API address must start with http:// or https://.')
  const headers = { ...request.headers }
  let body: BodyInit
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
  const response = await fetch(request.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(120_000) })
  return { status: response.status, body: await response.text() }
}

function registerIpc(): void {
  // Everything here is for the app's own page only.
  const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => event.senderFrame?.url.startsWith(ORIGIN) === true

  ipcMain.on('sotto:version', (event) => { event.returnValue = app.getVersion() })
  ipcMain.handle('sotto:paste', (event, text: string, restore: boolean) => (trusted(event) ? paste(String(text), restore === true) : undefined))
  ipcMain.handle('sotto:http', (event, request: HttpRequest) => {
    if (!trusted(event)) throw new Error('not allowed')
    return http(request)
  })
  ipcMain.handle('sotto:secret-get', (event, name: string) => (trusted(event) ? getSecret(String(name)) : ''))
  ipcMain.handle('sotto:secret-set', (event, name: string, value: string) => (trusted(event) ? setSecret(String(name), String(value)) : undefined))
  ipcMain.handle('sotto:key-listener', () => listener)
  ipcMain.on('sotto:phase', (event, next: Phase) => { if (trusted(event)) setPhase(next) })
  ipcMain.on('sotto:configure', (event, options: { hotkeys?: string[]; launchAtLogin?: boolean }) => {
    if (!trusted(event)) return
    const codes = (options.hotkeys ?? []).map((id) => KEYCODES[id]).filter((code) => code !== undefined)
    if (codes.length) hotkeys = new Set(codes)
    held = undefined
    // Only the installed app registers itself: a development run would register Electron itself.
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: options.launchAtLogin === true, args: ['--hidden'] })
    }
  })
}
