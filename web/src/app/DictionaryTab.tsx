import { useState } from 'preact/hooks'
import type { Settings } from '../core/settings'
import { Close, Plus, Trash } from './icons'
import type { App } from './main'
import { useStore } from './store'

export function DictionaryTab({ app }: { app: App }) {
  const settings = useStore(app.settings)
  const set = (change: Partial<Settings>) => app.settings.update((s) => ({ ...s, ...change }))
  const [term, setTerm] = useState('')

  const addTerm = () => {
    const t = term.trim()
    if (t && !settings.vocabulary.some((v) => v.toLowerCase() === t.toLowerCase())) set({ vocabulary: [...settings.vocabulary, t] })
    setTerm('')
  }
  const at = <T,>(items: readonly T[], index: number, change: Partial<T>) =>
    items.map((item, i) => (i === index ? { ...item, ...change } : item))

  return (
    <>
      <section class="card">
        <h2>Names and terms</h2>
        <div class="chips">
          {settings.vocabulary.map((v) => (
            <span class="chip">{v}<button aria-label={`Remove ${v}`} onClick={() => set({ vocabulary: settings.vocabulary.filter((x) => x !== v) })}><Close /></button></span>
          ))}
        </div>
        <form class="add" onSubmit={(e) => { e.preventDefault(); addTerm() }}>
          <input type="text" placeholder="A name, product or bit of jargon, spelled the way you want it" value={term}
            onInput={(e) => setTerm((e.currentTarget as HTMLInputElement).value)} />
          <button class="button" type="submit"><Plus /> Add</button>
        </form>
        <p class="help">The editing pass is told to spell these exactly. They also keep their capital letter in the middle of a sentence.</p>
      </section>

      <section class="card">
        <h2>Replacements</h2>
        {settings.replacements.map((r, i) => (
          <div class="pair">
            <input type="text" placeholder="When Sotto hears…" value={r.heard}
              onInput={(e) => set({ replacements: at(settings.replacements, i, { heard: (e.currentTarget as HTMLInputElement).value }) })} />
            <span class="arrow">→</span>
            <input type="text" placeholder="…write this" value={r.written}
              onInput={(e) => set({ replacements: at(settings.replacements, i, { written: (e.currentTarget as HTMLInputElement).value }) })} />
            <button class="button quiet" aria-label="Remove" onClick={() => set({ replacements: settings.replacements.filter((_, j) => j !== i) })}><Trash /></button>
          </div>
        ))}
        <button class="button" onClick={() => set({ replacements: [...settings.replacements, { heard: '', written: '' }] })}><Plus /> Add a replacement</button>
        <p class="help">For words that keep coming out wrong: “soto” → “Sotto”. Whole words only, any capitalization.</p>
      </section>

      <section class="card">
        <h2>Snippets</h2>
        {settings.snippets.map((s, i) => (
          <div class="pair">
            <input type="text" placeholder="When I say…" value={s.trigger}
              onInput={(e) => set({ snippets: at(settings.snippets, i, { trigger: (e.currentTarget as HTMLInputElement).value }) })} />
            <span class="arrow">→</span>
            <textarea rows={2} placeholder="…type this" value={s.expansion}
              onInput={(e) => set({ snippets: at(settings.snippets, i, { expansion: (e.currentTarget as HTMLTextAreaElement).value }) })} />
            <button class="button quiet" aria-label="Remove" onClick={() => set({ snippets: settings.snippets.filter((_, j) => j !== i) })}><Trash /></button>
          </div>
        ))}
        <button class="button" onClick={() => set({ snippets: [...settings.snippets, { trigger: '', expansion: '' }] })}><Plus /> Add a snippet</button>
        <p class="help">Spoken shortcuts: say “my address” and the whole address is typed.</p>
      </section>
    </>
  )
}
