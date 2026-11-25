import { SAMPLE_RATE } from '../core/audio'

/** Longest single recording, in seconds. */
export const MAX_SECONDS = 300

/**
 * The microphone as 16 kHz mono floats. The browser does the resampling: the audio context is
 * created at 16 kHz and the microphone is connected to it.
 */
export class Recorder {
  /** About 25 times a second while recording: loudness from 0 to 1. */
  onLevel: (level: number) => void = () => {}
  /** The recording reached MAX_SECONDS. */
  onLimit: () => void = () => {}

  private context: AudioContext | undefined
  private stream: MediaStream | undefined
  private node: AudioWorkletNode | undefined
  private blocks: Float32Array[] = []
  private samples = 0

  get recording(): boolean {
    return this.stream !== undefined
  }

  /** True when the last recording wanted a particular microphone and had to use the default one. */
  usedDefaultInstead = false

  /** `deviceId` picks a microphone (see `microphones()`); empty means the system's default. */
  async start(deviceId = ''): Promise<void> {
    if (this.stream) return
    this.blocks = []
    this.samples = 0
    this.usedDefaultInstead = false
    const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio })
    } catch (error) {
      // The chosen microphone is unplugged: dictating with another one beats not dictating.
      const missing = error instanceof DOMException && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')
      if (!deviceId || !missing) throw error
      this.usedDefaultInstead = true
      stream = await navigator.mediaDevices.getUserMedia({ audio })
    }
    this.stream = stream
    try {
      if (!this.context) {
        this.context = new AudioContext({ sampleRate: SAMPLE_RATE })
        await this.context.audioWorklet.addModule(new URL('recorder-worklet.js', document.baseURI))
      }
      await this.context.resume()
      // stop() may have been called while the microphone was opening.
      if (this.stream !== stream) return
      const node = new AudioWorkletNode(this.context, 'sotto-capture')
      node.port.onmessage = (event: MessageEvent<Float32Array>) => this.take(event.data)
      this.context.createMediaStreamSource(stream).connect(node)
      this.node = node
    } catch (error) {
      this.close()
      throw error
    }
  }

  private take(block: Float32Array): void {
    if (!this.stream) return
    this.blocks.push(block)
    this.samples += block.length
    let sum = 0
    for (const v of block) sum += v * v
    const decibels = 20 * Math.log10(Math.sqrt(sum / block.length) + 1e-7)
    this.onLevel(Math.max(0, Math.min(1, (decibels + 50) / 40)))
    if (this.samples >= MAX_SECONDS * SAMPLE_RATE) this.onLimit()
  }

  /** Ends the recording and returns it. */
  stop(): Float32Array {
    const out = new Float32Array(this.samples)
    let at = 0
    for (const block of this.blocks) {
      out.set(block, at)
      at += block.length
    }
    this.close()
    return out
  }

  private close(): void {
    this.node?.disconnect()
    this.node = undefined
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    this.blocks = []
    this.samples = 0
    void this.context?.suspend()
  }
}

/** 'granted', 'denied', or 'prompt' when the browser has yet to ask. */
export async function microphonePermission(): Promise<PermissionState> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state
  } catch {
    return 'prompt'
  }
}

export async function requestMicrophone(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    return true
  } catch {
    return false
  }
}

export interface Microphone { id: string; label: string }

/** The connected microphones. Browsers only name them once the microphone has been allowed. */
export async function microphones(): Promise<Microphone[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }))
  } catch {
    return []
  }
}
