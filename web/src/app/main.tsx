import { render } from 'preact'
import { HOTKEYS, type Settings } from '../core/settings'
import { describeGpu } from '../engine/lfm'
import { demoHistory, demoSettings } from './demo'
import { Dictation } from './dictation'
import { DictionaryTab } from './DictionaryTab'
import { Engine } from './engine'
import { HistoryTab } from './HistoryTab'
import { Home } from './Home'
import { Logo } from './icons'
import { createHistory, createSettings, loadApiKey, type HistoryEntry } from './persist'
import { desktop } from './platform'
import { SettingsTab } from './SettingsTab'
import { Store, useStore } from './store'
import './styles.css'

export type Tab = 'home' | 'settings' | 'dictionary' | 'history'

/** Everything the screens share. */
export interface App {
  settings: Store<Settings>
  history: Store<HistoryEntry[]>
  apiKey: Store<string>
  engine: Engine
  dictation: Dictation
  tab: Store<Tab>
  /** The text in the dictation pad. */
  pad: Store<string>
  /** The pad's text area while the home screen is showing. */
  padElement: HTMLTextAreaElement | null
  /** Fetches the API key from secure storage, once, the first time the API is selected or shown. */
  loadApiKey: () => Promise<void>
}

const query = new URLSearchParams(location.search)
/** `?demo` shows made-up content and touches no stored data: for screenshots. */
const demo = query.has('demo')
const theme = query.get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme

const settings = demo ? new Store(demoSettings()) : createSettings()
const history = demo ? new Store(demoHistory()) : createHistory()
const engine = new Engine(settings, desktop ? (request) => desktop!.http(request) : undefined)
const app: App = {
  settings,
  history,
  apiKey: new Store(''),
  engine,
  dictation: new Dictation(settings, history, engine),
  tab: new Store<Tab>((query.get('tab') as Tab) || 'home'),
  pad: new Store(demo ? 'Hey Marcus, thanks for sending over the quarterly report. I had a look this morning and the numbers look solid.\n\nCan we meet on Thursday to go over the budget?' : ''),
  padElement: null,
  loadApiKey: () => (keyLoaded ??= demo || !desktop ? Promise.resolve() : loadApiKey().then((key) => app.apiKey.set(key))),
}
let keyLoaded: Promise<void> | undefined

/** The pad is the target when it is showing and, in the Windows app, when it has the keyboard. */
function padIsTarget(): boolean {
  if (!desktop) return true
  return document.hasFocus() && app.padElement !== null && document.activeElement === app.padElement
}

function insertIntoPad(text: string): void {
  const area = app.padElement
  const current = app.pad.value
  const start = area ? area.selectionStart : current.length
  const end = area ? area.selectionEnd : current.length
  app.pad.set(current.slice(0, start) + text + current.slice(end))
  if (area) {
    const caret = start + text.length
    requestAnimationFrame(() => area.setSelectionRange(caret, caret))
  }
}

app.dictation.before = () => {
  if (!padIsTarget()) return null
  const area = app.padElement
  return area ? app.pad.value.slice(0, area.selectionStart) : app.pad.value
}

app.dictation.deliver = async (text) => {
  if (padIsTarget()) {
    insertIntoPad(text)
    if (!desktop && settings.value.copyAutomatically) await navigator.clipboard.writeText(app.pad.value).catch(() => undefined)
  } else {
    await desktop!.paste(text, settings.value.restoreClipboard)
  }
}

if (desktop) {
  // The Windows app listens for the keys system-wide and reports them here.
  desktop.onKey((event) => app.dictation.key(event))
  desktop.onCommand((command) => {
    if (command === 'settings' || command === 'home' || command === 'history') app.tab.set(command)
    if (command === 'copy-last' && history.value[0]) void navigator.clipboard.writeText(history.value[0].text)
  })
  const configure = (s: Settings) => desktop!.configure({ hotkeys: s.hotkeys, launchAtLogin: s.launchAtLogin })
  configure(settings.value)
  settings.subscribe(configure)
  app.dictation.phase.subscribe((phase) => desktop!.setPhase(phase))
} else {
  // In a browser the keys only reach the page while it has the keyboard.
  const codes = () => new Set<string>(HOTKEYS.filter((k) => settings.value.hotkeys.includes(k.id)).map((k) => k.code))
  window.addEventListener('keydown', (event) => {
    if (codes().has(event.code)) {
      if (!event.repeat) app.dictation.key('down')
    } else if (event.key === 'Escape') {
      app.dictation.key('escape')
    } else {
      app.dictation.key('other')
    }
  })
  window.addEventListener('keyup', (event) => {
    if (codes().has(event.code)) app.dictation.key('up')
  })
  window.addEventListener('blur', () => {
    // A key released while another window has the keyboard never reports its release.
    if (app.dictation.phase.value === 'recording') app.dictation.key('up')
  })
}

if (demo) {
  // The made-up part is the content; the graphics adapter named on screen is the real one.
  engine.state.set({ kind: 'ready', gpu: '', loadMs: 0 })
  void describeGpu().then((gpu) => engine.state.set({ kind: 'ready', gpu: gpu.name, loadMs: 0 }))
} else {
  // Secure storage is left alone unless the API is the engine in use.
  const ready = engine.usesApi ? app.loadApiKey() : Promise.resolve()
  void ready.then(() => engine.refresh()).then(() => {
    // The Windows app lives in the tray: have the model ready before the first key press.
    if (desktop) void engine.warm()
  })
  settings.subscribe((value) => {
    if (desktop && value.engine.kind === 'cloud') void app.loadApiKey()
  })
}
app.apiKey.subscribe((key) => {
  engine.setApiKey(key)
  if (!demo) void engine.refresh()
})

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['home', 'Dictate'], ['settings', 'Settings'], ['dictionary', 'Dictionary'], ['history', 'History'],
]

function Shell() {
  const tab = useStore(app.tab)
  return (
    <div class="shell">
      <header class="top">
        <Logo />
        <div>
          <h1>Sotto</h1>
          <div class="tagline">Say it. It’s typed.</div>
        </div>
        <span class="spacer" />
        <nav class="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button role="tab" aria-selected={tab === id} onClick={() => app.tab.set(id)}>{label}</button>
          ))}
        </nav>
      </header>
      {tab === 'home' && <Home app={app} />}
      {tab === 'settings' && <SettingsTab app={app} />}
      {tab === 'dictionary' && <DictionaryTab app={app} />}
      {tab === 'history' && <HistoryTab app={app} />}
      <footer class="foot">
        {desktop ? `Sotto ${desktop.version} for Windows` : 'Sotto in your browser'} · speech model: LFM3-Audio-2B by Liquid AI
      </footer>
    </div>
  )
}

render(<Shell />, document.getElementById('app')!)

/** For the automated tests, which drive the page from outside. */
;(window as unknown as { sotto: object }).sotto = Object.assign(app, { describeGpu })
