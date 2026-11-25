import { PILL_CHANNEL, type PillState } from './platform'

/**
 * The small floating indicator the Windows app shows near the bottom of the screen while it is
 * listening or writing. It only draws what the main window tells it.
 */
const style = document.createElement('style')
style.textContent = `
  html, body { margin: 0; background: transparent; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; }
  #pill {
    position: fixed; inset: 6px; border-radius: 999px; background: rgba(24, 22, 34, 0.94); color: #fff;
    display: flex; align-items: center; justify-content: center; gap: 3px; font-size: 13px; font-weight: 600;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.12); padding: 0 14px; white-space: nowrap;
  }
  #pill i { width: 3px; border-radius: 2px; background: #a48fff; min-height: 3px; }
  #pill.handsFree i { background: #ff7480; }
  #pill .dot { width: 6px; height: 6px; border-radius: 50%; background: #a48fff; animation: pulse 1s ease-in-out infinite; }
  #pill .dot:nth-child(2) { animation-delay: 0.15s; }
  #pill .dot:nth-child(3) { animation-delay: 0.3s; }
  @keyframes pulse { 0%, 100% { opacity: 0.25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-3px); } }
`
document.head.append(style)

const pill = document.getElementById('pill')!
const BARS = 18

function draw(state: PillState): void {
  pill.className = state.phase
  if (state.notice && state.phase === 'idle') {
    pill.textContent = state.notice
  } else if (state.phase === 'processing') {
    pill.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>'
  } else {
    pill.replaceChildren(...Array.from({ length: BARS }, (_, i) => {
      const bar = document.createElement('i')
      const level = state.levels[state.levels.length - BARS + i] ?? 0
      bar.style.height = `${3 + level * 20}px`
      return bar
    }))
  }
}

draw({ phase: 'recording', levels: [], notice: '' })
new BroadcastChannel(PILL_CHANNEL).onmessage = (event: MessageEvent<PillState>) => draw(event.data)
