import { useEffect, useRef, useState } from 'preact/hooks'
import type { CleanupLevel, Tone } from '../core/postprocess'
import { HOTKEYS, LANGUAGES, withHotkey, type Settings } from '../core/settings'
import { MODEL_BYTES } from '../engine/modelStore'
import type { App } from './main'
import { saveApiKey } from './persist'
import { desktop } from './platform'
import { microphones, type Microphone } from './recorder'
import { useStore } from './store'

const CLEANUP: ReadonlyArray<readonly [CleanupLevel, string, string]> = [
  ['verbatim', 'Verbatim', 'Exactly what was said, fillers and all.'],
  ['light', 'Light', 'Removes “um”, “uh” and stutters. Nothing else changes.'],
  ['smart', 'Smart', 'A second pass also applies self-corrections (“at five, actually six”), fixes punctuation and formats spoken lists. English only.'],
]

const TONES: ReadonlyArray<readonly [Tone, string]> = [
  ['formal', 'Formal: full sentences, capitals and periods'],
  ['casual', 'Casual: no final period'],
  ['veryCasual', 'Very casual: lower case, no final period'],
]

export function SettingsTab({ app }: { app: App }) {
  const settings = useStore(app.settings)
  const engine = useStore(app.engine.state)
  const apiKey = useStore(app.apiKey)
  const set = (change: Partial<Settings>) => app.settings.update((s) => ({ ...s, ...change }))
  const setEngine = (change: Partial<Settings['engine']>) => set({ engine: { ...settings.engine, ...change } })
  const [key, setKey] = useState(apiKey)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => setKey(apiKey), [apiKey])
  const cloud = app.engine.usesApi
  // The stored key is only fetched once the API is being set up or used.
  useEffect(() => { if (cloud) void app.loadApiKey() }, [cloud])
  const [inputs, setInputs] = useState<Microphone[]>([])
  useEffect(() => {
    const refresh = () => void microphones().then(setInputs)
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  }, [])
  const hasModel = engine.kind === 'resting' || engine.kind === 'ready' || engine.kind === 'loading'
    || (engine.kind === 'absent' && engine.bytes > 0)

  return (
    <>
      <section class="card">
        <h2>Dictation</h2>
        <div class="field top">
          <span class="label">Dictation keys</span>
          <div class="checks">
            {HOTKEYS.map((k) => (
              <label>
                <input type="checkbox" checked={settings.hotkeys.includes(k.id)}
                  disabled={settings.hotkeys.length === 1 && settings.hotkeys[0] === k.id}
                  onChange={(e) => set({ hotkeys: withHotkey(settings.hotkeys, k.id, (e.currentTarget as HTMLInputElement).checked) })} />
                {k.label}
              </label>
            ))}
          </div>
          <div class="note">
            Any ticked key starts dictation: hold it to talk, or tap it twice for hands-free.
            {desktop ? ' F13 to F16 suit a keyboard’s macro keys.' : ' Here in the browser they work while this page has the keyboard.'}
          </div>
        </div>
        <div class="field">
          <label for="microphone">Microphone</label>
          <select id="microphone" value={settings.microphoneId}
            onChange={(e) => {
              const id = (e.currentTarget as HTMLSelectElement).value
              set({ microphoneId: id, microphoneLabel: inputs.find((m) => m.id === id)?.label ?? '' })
            }}>
            <option value="">System default</option>
            {inputs.map((m) => <option value={m.id}>{m.label}</option>)}
            {settings.microphoneId && !inputs.some((m) => m.id === settings.microphoneId) && (
              <option value={settings.microphoneId}>{settings.microphoneLabel || 'The chosen microphone'} (not connected; using the default)</option>
            )}
          </select>
          {inputs.length === 0 && <div class="note">Microphones are listed once the microphone has been allowed.</div>}
        </div>
        <div class="field">
          <label for="language">Language</label>
          <select id="language" value={settings.language} onChange={(e) => set({ language: (e.currentTarget as HTMLSelectElement).value })}>
            <option value="">Detect automatically</option>
            {LANGUAGES.map(([name]) => <option value={name}>{name}</option>)}
          </select>
        </div>
      </section>

      <section class="card">
        <h2>Editing</h2>
        <div class="field top">
          <span class="label">How much to tidy</span>
          <div>
            <div class="segmented">
              {CLEANUP.map(([value, label]) => (
                <button aria-pressed={settings.cleanup === value} onClick={() => set({ cleanup: value })}>{label}</button>
              ))}
            </div>
            <p class="help">{CLEANUP.find(([value]) => value === settings.cleanup)![2]}</p>
          </div>
        </div>
        <div class="field">
          <label for="tone">Tone</label>
          <select id="tone" value={settings.tone} onChange={(e) => set({ tone: (e.currentTarget as HTMLSelectElement).value as Tone })}>
            {TONES.map(([value, label]) => <option value={value}>{label}</option>)}
          </select>
        </div>
      </section>

      {desktop && (
      <section class="card">
        <h2>Speech engine</h2>
        <label class={`choice ${cloud ? '' : 'on'}`}>
          <input type="radio" name="engine" checked={!cloud} onChange={() => setEngine({ kind: 'local' })} />
          <div>
            <div class="title">On this computer</div>
            <div class="detail">LFM3-Audio-2B on your graphics card, through WebGPU. Private and free; a {(MODEL_BYTES / 1e9).toFixed(1)} GB download.</div>
          </div>
        </label>
        <label class={`choice ${cloud ? 'on' : ''}`}>
          <input type="radio" name="engine" checked={cloud} onChange={() => setEngine({ kind: 'cloud' })} />
          <div>
            <div class="title">An OpenAI-compatible API</div>
            <div class="detail">OpenAI, Groq, or a server of your own (speaches, LocalAI, vLLM…). Your recordings are sent to the address below.</div>
          </div>
        </label>
        {cloud && (
          <div style={{ marginTop: '14px' }}>
            <div class="field">
              <label for="baseUrl">API address</label>
              <input id="baseUrl" type="url" spellcheck={false} placeholder="https://api.openai.com/v1" value={settings.engine.baseUrl}
                onInput={(e) => setEngine({ baseUrl: (e.currentTarget as HTMLInputElement).value })} />
              <div class="note">Sotto adds <code>/audio/transcriptions</code> to it.</div>
            </div>
            <div class="field">
              <label for="apiKey">API key</label>
              <input id="apiKey" type="password" autocomplete="off" placeholder="Leave empty if the server needs none" value={key}
                onInput={(e) => {
                  // Saved shortly after the last keystroke, so a key typed and never "left" is not lost.
                  const value = (e.currentTarget as HTMLInputElement).value
                  setKey(value)
                  clearTimeout(saveTimer.current)
                  saveTimer.current = setTimeout(() => { app.apiKey.set(value); void saveApiKey(value) }, 400)
                }} />
              <div class="note">Stored encrypted with your Windows account.</div>
            </div>
            <div class="field">
              <label for="model">Transcription model</label>
              <input id="model" type="text" spellcheck={false} placeholder="gpt-4o-mini-transcribe" value={settings.engine.model}
                onInput={(e) => setEngine({ model: (e.currentTarget as HTMLInputElement).value })} />
            </div>
            <div class="field">
              <label for="cleanupModel">Editing model</label>
              <input id="cleanupModel" type="text" spellcheck={false} placeholder="Optional, for example gpt-4o-mini" value={settings.engine.cleanupModel}
                onInput={(e) => setEngine({ cleanupModel: (e.currentTarget as HTMLInputElement).value })} />
              <div class="note">A chat model for the Smart editing pass, through <code>/chat/completions</code>. Without one, Smart behaves like Light.</div>
            </div>
          </div>
        )}
      </section>
      )}

      <section class="card">
        <h2>Behaviour</h2>
        <div class="field">
          <span class="label">Sounds</span>
          <label class="switch"><input type="checkbox" checked={settings.sounds} onChange={(e) => set({ sounds: (e.currentTarget as HTMLInputElement).checked })} /> Play a soft tone at start and finish</label>
        </div>
        <div class="field">
          <span class="label">History</span>
          <label class="switch"><input type="checkbox" checked={settings.keepHistory} onChange={(e) => set({ keepHistory: (e.currentTarget as HTMLInputElement).checked })} /> Keep what I dictate, on this computer</label>
        </div>
        {desktop ? (
          <>
            <div class="field">
              <span class="label">Clipboard</span>
              <label class="switch"><input type="checkbox" checked={settings.restoreClipboard} onChange={(e) => set({ restoreClipboard: (e.currentTarget as HTMLInputElement).checked })} /> Put my clipboard back after pasting</label>
            </div>
            <div class="field">
              <span class="label">Startup</span>
              <label class="switch"><input type="checkbox" checked={settings.launchAtLogin} onChange={(e) => set({ launchAtLogin: (e.currentTarget as HTMLInputElement).checked })} /> Start Sotto when I sign in</label>
            </div>
          </>
        ) : (
          <div class="field">
            <span class="label">Clipboard</span>
            <label class="switch"><input type="checkbox" checked={settings.copyAutomatically} onChange={(e) => set({ copyAutomatically: (e.currentTarget as HTMLInputElement).checked })} /> Copy each dictation as it lands</label>
          </div>
        )}
        {!cloud && (
          <div class="field">
            <label for="unload">Free the memory after</label>
            <select id="unload" value={String(settings.unloadAfterMinutes)} onChange={(e) => set({ unloadAfterMinutes: Number((e.currentTarget as HTMLSelectElement).value) })}>
              {[5, 15, 60].map((m) => <option value={String(m)}>{m} minutes without dictation</option>)}
              <option value="0">Never: keep the model loaded</option>
            </select>
            <div class="note">The loaded model holds about 2 GB of graphics memory. Loading it again takes a few seconds.</div>
          </div>
        )}
        {hasModel && (
          <div class="field">
            <span class="label">Downloaded model</span>
            <div><button class="button" onClick={() => { if (confirm('Delete the downloaded speech model? It can be downloaded again.')) void app.engine.remove() }}>Delete the model files</button></div>
          </div>
        )}
      </section>
    </>
  )
}
