import { useState } from 'preact/hooks'
import { Copy } from './icons'
import type { App } from './main'
import { useStore } from './store'

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function HistoryTab({ app }: { app: App }) {
  const history = useStore(app.history)
  const [copied, setCopied] = useState(-1)
  const copy = async (text: string, at: number) => {
    await navigator.clipboard.writeText(text)
    setCopied(at)
    setTimeout(() => setCopied(-1), 1500)
  }
  return (
    <section class="card">
      <h2>Recent dictations</h2>
      {history.length === 0 && <div class="empty">Nothing yet. What you dictate shows up here, and stays on this computer.</div>}
      {history.map((entry) => (
        <div class="entry">
          <div class="text">
            {entry.text}
            <div class="meta">{when(entry.at)} · {entry.audioSeconds.toFixed(0)} s of speech · {(entry.ms / 1000).toFixed(1)} s to write</div>
          </div>
          <button class="button quiet" onClick={() => copy(entry.text, entry.at)}><Copy /> {copied === entry.at ? 'Copied' : 'Copy'}</button>
        </div>
      ))}
      {history.length > 0 && (
        <div class="actions">
          <span class="spacer" />
          <button class="button" onClick={() => { if (confirm('Delete the whole history?')) app.history.set([]) }}>Clear history</button>
        </div>
      )}
    </section>
  )
}
