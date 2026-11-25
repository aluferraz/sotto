import type { DictationResult } from './lfm'
import type { StoreStatus } from './modelStore'

/** Messages between the page and the engine worker. Every request gets exactly one reply. */
export type Request =
  | { type: 'status' }
  | { type: 'download' }
  | { type: 'cancelDownload' }
  | { type: 'remove' }
  | { type: 'load' }
  | { type: 'unload' }
  | { type: 'prepare'; vocabulary: string[] }
  | { type: 'dictate'; samples: Float32Array; language: string; smart: boolean; vocabulary: string[] }

export type Reply =
  | { type: 'status'; status: StoreStatus }
  | { type: 'loaded'; gpu: string; loadMs: number }
  | { type: 'result'; result: DictationResult }
  | { type: 'done' }

export type FromWorker =
  | { id: number; reply: Reply }
  | { id: number; error: string }
  | { id: number; progress: { bytes: number; total: number; stage: 'downloading' | 'verifying' } }
  | { id: number; stage: string }
  | { id: number; partial: string }

export interface ToWorker {
  id: number
  request: Request
  /** Where the model files come from; set once, with the first message. */
  base?: string
}
