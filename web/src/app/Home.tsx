import { useEffect, useRef, useState } from 'preact/hooks'
import { hotkeyNames, HOTKEYS } from '../core/settings'
import type { App } from './main'
import type { EngineState } from './engine'
import { Check, Copy, Mic, Stop } from './icons'
import { desktop } from './platform'
import { microphonePermission, requestMicrophone } from './recorder'
import { useStore } from './store'

const megabytes = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`

function Keys({ ids }: { ids: readonly string[] }) {
  const labels = HOTKEYS.filter((k) => ids.includes(k.id)).map((k) => k.label)
  return <>{labels.map((label, i) => <>{i > 0 && (i === labels.length - 1 ? ' or ' : ', ')}<kbd>{label}</kbd></>)}</>
}

export function Home({ app }: { app: App }) {
  const settings = useStore(app.settings)
  const phase = useStore(app.dictation.phase)
  const partial = useStore(app.dictation.partial)
  const notice = useStore(app.dictation.notice)
  const levels = useStore(app.dictation.levels)
  const engine = useStore(app.engine.state)
  const pad = useStore(app.pad)
  const area = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    app.padElement = area.current
    return () => { app.padElement = null }
  }, [])

  const live = phase === 'recording' || phase === 'handsFree'
  const level = levels.length ? levels[levels.length - 1] : 0
  const title = phase === 'processing' ? 'Writing it down…'
    : phase === 'handsFree' ? 'Listening, hands-free'
    : phase === 'recording' ? 'Listening…'
    : 'Ready when you are'

  const copy = async () => {
    await navigator.clipboard.writeText(pad)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <section class="card hero">
        <button
          class={`mic ${live ? 'live' : ''} ${phase === 'processing' ? 'busy' : ''}`}
          style={{ '--level': level }}
          aria-label={live ? 'Finish dictation' : 'Start dictation'}
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); app.dictation.buttonDown() }}
          onPointerUp={() => app.dictation.buttonUp()}
          onPointerCancel={() => app.dictation.buttonUp()}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); app.dictation.buttonDown(); app.dictation.buttonUp() } }}
        >
          {phase === 'processing' ? <span class="ring" /> : null}
          {live ? <Stop size={30} /> : <Mic size={34} />}
        </button>
        <div class="words">
          <div class="state">{title}</div>
          {live ? (
            <div class="bars">{Array.from({ length: 28 }, (_, i) => {
              const v = levels[levels.length - 28 + i] ?? 0
              return <i style={{ height: `${4 + v * 30}px` }} />
            })}</div>
          ) : phase === 'processing' ? (
            <div class="partial">{partial || 'Listening back to what you said.'}</div>
          ) : (
            <div class="hint">
              {desktop
                ? <>Hold <Keys ids={settings.hotkeys} /> in any app and speak. Tap it twice to keep talking hands-free.</>
                : <>Hold <Keys ids={settings.hotkeys} /> and speak, or tap the microphone. Tap the key twice to go hands-free.</>}
            </div>
          )}
          {live && <div class="hint">{phase === 'handsFree' ? 'Press the key or the button again to finish. ' : 'Release to finish. '}<kbd>Esc</kbd> cancels.</div>}
          {notice && <div class="notice">{notice}</div>}
        </div>
      </section>

      <section class="card">
        <h2>Setup</h2>
        <EngineRow app={app} state={engine} />
        <MicrophoneRow />
        {desktop && <KeyRow names={hotkeyNames(settings.hotkeys)} />}
      </section>

      <section class="card">
        <h2>{desktop ? 'Try it here' : 'Your words'}</h2>
        <textarea
          ref={area}
          class="pad"
          placeholder={desktop ? 'Click here, hold the key and say something.' : 'What you dictate lands here, at the cursor. Type to fix things up.'}
          value={pad}
          onInput={(e) => app.pad.set((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <div class="actions">
          <button class="button" onClick={copy} disabled={!pad}><Copy /> {copied ? 'Copied' : 'Copy'}</button>
          <button class="button quiet" onClick={() => app.pad.set('')} disabled={!pad}>Clear</button>
          <span class="spacer" />
          <span class="small">{app.engine.usesApi ? 'Audio is sent to your API.' : 'Audio stays on this computer.'}</span>
        </div>
      </section>
    </>
  )
}

function Row(props: { status: 'done' | 'todo' | 'warn' | 'work'; title: string; detail: preact.ComponentChildren; problem?: boolean; children?: preact.ComponentChildren }) {
  return (
    <div class="row">
      <span class={`dot ${props.status}`}>{props.status === 'done' && <Check />}</span>
      <div class="body">
        <div class="title">{props.title}</div>
        <div class={`detail ${props.problem ? 'problem' : ''}`}>{props.detail}</div>
      </div>
      {props.children}
    </div>
  )
}

function EngineRow({ app, state }: { app: App; state: EngineState }) {
  const engine = app.engine
  const settings = app.settings.value.engine
  switch (state.kind) {
    case 'checking':
      return <Row status="work" title="Speech engine" detail="Checking what this computer can do." />
    case 'cloud': {
      let host = settings.baseUrl
      try { host = new URL(settings.baseUrl).host } catch { /* shown as typed */ }
      return state.problem
        ? <Row status="warn" title="Speech engine: your API" detail={state.problem} problem>
            <button class="button" onClick={() => app.tab.set('settings')}>Open Settings</button>
          </Row>
        : <Row status="done" title="Speech engine: your API" detail={`${settings.model} at ${host}`} />
    }
    case 'unsupported':
      return <Row status="warn" title="Speech engine" problem
        detail={desktop
          ? `${state.reason} You can use an OpenAI-compatible API instead.`
          : `${state.reason} Sotto needs WebGPU: try a recent Chrome or Edge on a computer with a graphics card from the last several years.`}>
        {desktop && <button class="button" onClick={() => app.tab.set('settings')}>Open Settings</button>}
      </Row>
    case 'absent':
      return <Row status="todo" title="Speech engine: LFM3-Audio on this computer"
        detail={state.bytes > 0
          ? `${megabytes(state.bytes)} of ${megabytes(state.total)} downloaded.`
          : `A ${megabytes(state.total)} download, once. After that nothing leaves this computer.`}>
        <button class="button primary" onClick={() => engine.download()}>{state.bytes > 0 ? 'Continue' : 'Download'}</button>
      </Row>
    case 'downloading':
      return <Row status="work" title="Speech engine: downloading"
        detail={<>
          {state.verifying ? 'Checking the files…' : `${megabytes(state.bytes)} of ${megabytes(state.total)}`}
          <div class="progress"><i style={{ width: `${(100 * state.bytes) / state.total}%` }} /></div>
        </>}>
        <button class="button" onClick={() => engine.cancelDownload()}>Pause</button>
      </Row>
    case 'resting':
      return <Row status="done" title="Speech engine: LFM3-Audio on this computer" detail="Downloaded. It loads when you start dictating.">
        <button class="button" onClick={() => engine.warm()}>Load now</button>
      </Row>
    case 'loading':
      return <Row status="work" title="Speech engine: waking up" detail={`${state.stage}…`} />
    case 'ready':
      return <Row status="done" title="Speech engine: LFM3-Audio on this computer" detail={`Loaded on the GPU${state.gpu ? ` (${state.gpu})` : ''}.`} />
    case 'failed':
      return <Row status="warn" title="Speech engine" detail={state.message} problem>
        <button class="button" onClick={async () => { await engine.refresh(); if (engine.state.value.kind === 'absent') void engine.download(); else void engine.warm() }}>Try again</button>
      </Row>
  }
}

function MicrophoneRow() {
  const [permission, setPermission] = useState<PermissionState>('prompt')
  useEffect(() => {
    const check = () => microphonePermission().then(setPermission)
    void check()
    const timer = setInterval(check, 2000)
    return () => clearInterval(timer)
  }, [])
  if (permission === 'granted') return <Row status="done" title="Microphone" detail="Allowed." />
  return (
    <Row status={permission === 'denied' ? 'warn' : 'todo'} title="Microphone" problem={permission === 'denied'}
      detail={permission === 'denied'
        ? (desktop ? 'Windows is blocking the microphone. Allow desktop apps in Settings → Privacy & security → Microphone.' : 'Blocked for this site. Allow it from the icon in the address bar.')
        : 'Needed to hear you. It is only on while you dictate.'}>
      {permission !== 'denied' && <button class="button primary" onClick={() => requestMicrophone().then(() => microphonePermission().then(setPermission))}>Allow</button>}
    </Row>
  )
}

function KeyRow({ names }: { names: string }) {
  const [status, setStatus] = useState<{ ok: boolean; message: string }>({ ok: true, message: '' })
  useEffect(() => { void desktop?.keyListener().then(setStatus) }, [names])
  return status.ok
    ? <Row status="done" title="Dictation key" detail={`${names} works in every app. Change it in Settings.`} />
    : <Row status="warn" title="Dictation key" detail={status.message} problem />
}
