import { DECODER_DATA_NAME, ENCODER_DATA_NAME, type ModelFiles } from './lfm'

/**
 * The model's files and where they are kept: the browser's private file system for this site
 * (OPFS), which survives restarts and holds files of this size. Runs inside the engine worker.
 */
export const MODEL = {
  repository: 'LiquidAI/LFM3-Audio-2B-ONNX',
  /** A fixed revision, so the files and their checksums cannot change under the app. */
  revision: 'ac6eed2a1d6b16c785bfc1edc06b623164a22477',
  files: [
    { name: 'tokenizer.json', path: 'tokenizer.json', size: 17_908_634, sha256: '41927bd314d17d7d7fadb44e10cd0919f7b71528d7741596d8cbd15c6945ec44' },
    { name: 'audio_encoder.onnx', path: 'onnx/audio_encoder.onnx', size: 162_507, sha256: 'c68ddaf64339aa2bc6c841b0ec0da3be89027849991cbd7e546d3d3156094921' },
    { name: ENCODER_DATA_NAME, path: `onnx/${ENCODER_DATA_NAME}`, size: 510_351_360, sha256: 'd5fed72d461d7c052f2e65c79421f955fe02c55b220caeba69b40201cffb0358' },
    { name: 'decoder_q4f16.onnx', path: 'onnx/decoder_q4f16.onnx', size: 274_325, sha256: '5f207e9d27d0f5ae6ee1a53609e75cca1740ce72df0702496bd4f1b2f20d2e38' },
    { name: DECODER_DATA_NAME, path: `onnx/${DECODER_DATA_NAME}`, size: 1_413_388_288, sha256: 'b296939c604313a69a14829839c7542875792c6b30054986ec1c633dc16ae555' },
  ],
} as const

export const MODEL_BYTES = MODEL.files.reduce((sum, f) => sum + f.size, 0)

export const DEFAULT_BASE = `https://huggingface.co/${MODEL.repository}/resolve/${MODEL.revision}/`

const FOLDER = `sotto-model-${MODEL.revision.slice(0, 12)}`
const VERIFIED = 'verified.json'

export interface StoreStatus {
  /** Every file is here and has passed its checksum. */
  ready: boolean
  /** Bytes on disk so far, counting unfinished downloads. */
  bytes: number
  total: number
}

export class Damaged extends Error {}

export class ModelStore {
  /** `base` ends in a slash; file paths are appended to it. A flat folder of the files also works. */
  constructor(private readonly base = DEFAULT_BASE) {}

  private async folder(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle(FOLDER, { create: true })
  }

  private async verified(folder: FileSystemDirectoryHandle): Promise<Set<string>> {
    try {
      const file = await (await folder.getFileHandle(VERIFIED)).getFile()
      return new Set(JSON.parse(await file.text()))
    } catch {
      return new Set()
    }
  }

  private async markVerified(folder: FileSystemDirectoryHandle, names: Set<string>): Promise<void> {
    const writable = await (await folder.getFileHandle(VERIFIED, { create: true })).createWritable()
    await writable.write(JSON.stringify([...names]))
    await writable.close()
  }

  private async sizeOf(folder: FileSystemDirectoryHandle, name: string): Promise<number> {
    try {
      return (await (await folder.getFileHandle(name)).getFile()).size
    } catch {
      return 0
    }
  }

  async status(): Promise<StoreStatus> {
    const folder = await this.folder()
    const verified = await this.verified(folder)
    let bytes = 0
    let ready = true
    for (const file of MODEL.files) {
      const size = await this.sizeOf(folder, file.name)
      bytes += Math.min(size, file.size)
      if (size !== file.size || !verified.has(file.name)) ready = false
    }
    return { ready, bytes, total: MODEL_BYTES }
  }

  /**
   * Downloads whatever is missing, continuing unfinished files where they stopped, and checks
   * every file against its published SHA-256. `onProgress` gets the total bytes on disk.
   */
  async download(onProgress: (bytes: number, stage: 'downloading' | 'verifying') => void, signal: AbortSignal): Promise<void> {
    const folder = await this.folder()
    const verified = await this.verified(folder)
    const sizes = new Map<string, number>()
    for (const file of MODEL.files) sizes.set(file.name, Math.min(await this.sizeOf(folder, file.name), file.size))
    const onDisk = () => [...sizes.values()].reduce((a, b) => a + b, 0)

    const missing = MODEL_BYTES - onDisk()
    const estimate = await navigator.storage.estimate?.()
    if (estimate?.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < missing) {
      throw new Error(`Not enough storage for the model: ${Math.ceil(missing / 1e6)} MB are still needed.`)
    }

    for (const file of MODEL.files) {
      if (verified.has(file.name) && sizes.get(file.name) === file.size) continue
      const handle = await folder.getFileHandle(file.name, { create: true })
      const access = await handle.createSyncAccessHandle()
      try {
        let have = access.getSize()
        if (have > file.size) {
          access.truncate(0)
          have = 0
        }
        if (have < file.size) {
          const flat = !this.base.startsWith('https://huggingface.co/')
          const url = this.base + (flat ? file.name : file.path)
          const response = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal })
          if (response.status === 200 && have > 0) {
            access.truncate(0) // the server ignored the range: start again
            have = 0
          } else if (response.status !== 200 && response.status !== 206) {
            throw new Error(`The download server answered ${response.status} for ${file.name}.`)
          }
          const reader = response.body!.getReader()
          let reported = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            access.write(value, { at: have })
            have += value.byteLength
            sizes.set(file.name, Math.min(have, file.size))
            if (have - reported > 4_000_000) {
              reported = have
              onProgress(onDisk(), 'downloading')
            }
          }
          access.flush()
          if (have !== file.size) throw new Error('The download stopped early. Try again to continue it.')
        }
      } finally {
        access.close()
      }
      onProgress(onDisk(), 'verifying')
      const bytes = await (await handle.getFile()).arrayBuffer()
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
      if (hex !== file.sha256) {
        await folder.removeEntry(file.name)
        throw new Damaged(`${file.name} arrived damaged. Try the download again.`)
      }
      verified.add(file.name)
      await this.markVerified(folder, verified)
    }
    onProgress(MODEL_BYTES, 'verifying')
  }

  /** The files in memory, ready for the runtime. About 1.9 GB. */
  async read(): Promise<ModelFiles> {
    const folder = await this.folder()
    const bytes = async (name: string) => new Uint8Array(await (await (await folder.getFileHandle(name)).getFile()).arrayBuffer())
    const [decoder, decoderData, encoder, encoderData, tokenizer] = await Promise.all([
      bytes('decoder_q4f16.onnx'), bytes(DECODER_DATA_NAME), bytes('audio_encoder.onnx'), bytes(ENCODER_DATA_NAME),
      (await (await folder.getFileHandle('tokenizer.json')).getFile()).text().then((t) => JSON.parse(t) as object),
    ])
    return { decoder, decoderData, encoder, encoderData, tokenizer }
  }

  async remove(): Promise<void> {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(FOLDER, { recursive: true }).catch(() => undefined)
  }
}
