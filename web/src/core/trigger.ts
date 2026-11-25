/**
 * The dictation key's behaviour as a pure state machine, so it can be tested without a keyboard:
 *
 *   idle ─down─▶ holding ─up after a real hold─▶ processing ─done─▶ idle
 *                   │ up after a quick tap
 *                   ▼
 *               tapPending ─down again in time─▶ handsFree ─down─▶ processing
 *                   │ no second tap
 *                   ▼
 *                  idle (recording discarded)
 *
 * Escape cancels from any active state. Any other key during a hold cancels quietly: the user
 * is typing a shortcut (Ctrl+C, AltGr+letter).
 */
export type TriggerState = 'idle' | 'holding' | 'tapPending' | 'handsFree' | 'processing'

export type TriggerInput =
  | 'keyDown' | 'keyUp' | 'escape' | 'otherKey'
  /** The wait for a second tap ran out. */
  | 'tapWindowExpired'
  /** The recording hit its maximum length. */
  | 'limitReached'
  /** Transcription finished, failed or was abandoned. */
  | 'processingEnded'

export type TriggerAction =
  | 'startRecording'
  /** Stop recording and transcribe. */
  | 'finishRecording'
  /** Stop recording and throw the audio away, showing nothing. */
  | 'discardQuietly'
  /** Stop recording and throw the audio away, telling the user. */
  | 'discardRecording'
  /** Ignore the transcription that is in flight. */
  | 'abandonProcessing'
  | 'startTapWindow' | 'stopTapWindow'
  | 'enteredHandsFree'

export class TriggerMachine {
  state: TriggerState = 'idle'
  /** A press shorter than this is a tap, not a hold. Milliseconds. */
  tapThreshold = 300
  private pressedAt = 0

  /** Back to idle without side effects, for when recording could not start. */
  reset(): void {
    this.state = 'idle'
  }

  handle(input: TriggerInput, at: number): TriggerAction[] {
    const go = (state: TriggerState, ...actions: TriggerAction[]) => {
      this.state = state
      return actions
    }
    switch (`${this.state}:${input}`) {
      case 'idle:keyDown':
        this.pressedAt = at
        return go('holding', 'startRecording')

      case 'holding:keyUp':
        return at - this.pressedAt >= this.tapThreshold
          ? go('processing', 'finishRecording')
          : go('tapPending', 'startTapWindow')
      case 'holding:otherKey': return go('idle', 'discardQuietly')
      case 'holding:escape': return go('idle', 'discardRecording')
      case 'holding:limitReached': return go('processing', 'finishRecording')

      case 'tapPending:keyDown': return go('handsFree', 'stopTapWindow', 'enteredHandsFree')
      case 'tapPending:tapWindowExpired': return go('idle', 'discardQuietly')
      case 'tapPending:otherKey': return go('idle', 'stopTapWindow', 'discardQuietly')
      case 'tapPending:escape': return go('idle', 'stopTapWindow', 'discardRecording')

      case 'handsFree:keyDown':
      case 'handsFree:limitReached':
        return go('processing', 'finishRecording')
      case 'handsFree:escape': return go('idle', 'discardRecording')

      case 'processing:escape': return go('idle', 'abandonProcessing')
      case 'processing:processingEnded': return go('idle')

      default:
        return []
    }
  }
}
