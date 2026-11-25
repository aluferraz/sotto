// Runs on the audio thread: hands the microphone's samples to the page in 40 ms blocks.
class SottoCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(640)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let at = 0
    while (at < channel.length) {
      const n = Math.min(channel.length - at, this.block.length - this.filled)
      this.block.set(channel.subarray(at, at + n), this.filled)
      this.filled += n
      at += n
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice())
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('sotto-capture', SottoCapture)
