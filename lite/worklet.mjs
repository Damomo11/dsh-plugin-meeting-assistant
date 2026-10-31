// AudioWorklet 处理器源码，由 lite/server.mjs 以 /worklet.js 路由对外提供。
// 内容与 src/voice/audio.worklet.ts 相同；PcmEncoder 的实现直接内联，
// 因为 worklet 加载时不支持相对路径的 import（addModule 的模块作用域没有 import 解析）。

class PcmEncoder {
  constructor(inputRate, emit, frameSamples = 3200) {
    if (!Number.isFinite(inputRate) || inputRate < 16000) throw new Error('Unsupported microphone sample rate');
    this.ratio = inputRate / 16000;
    this.emit = emit;
    this.frameSamples = frameSamples;
    this.remaining = this.ratio;
    this.sum = 0;
    this.samples = [];
  }
  push(input) {
    for (const sample of input) {
      let weight = 1;
      while (weight > 1e-8) {
        const used = Math.min(weight, this.remaining);
        this.sum += (Number.isFinite(sample) ? sample : 0) * used;
        this.remaining -= used;
        weight -= used;
        if (this.remaining < 1e-8) {
          this.samples.push(Math.max(-1, Math.min(1, this.sum / this.ratio)));
          this.remaining = this.ratio;
          this.sum = 0;
          if (this.samples.length >= this.frameSamples) this.flush();
        }
      }
    }
  }
  flush() {
    if (!this.samples.length) return;
    const bytes = new Uint8Array(this.samples.length * 2);
    const view = new DataView(bytes.buffer);
    this.samples.forEach((s, i) => view.setInt16(i * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true));
    this.samples = [];
    this.emit(bytes);
  }
}

class MeetingAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.encoder = new PcmEncoder(sampleRate, bytes => this.port.postMessage(bytes, [bytes.buffer]));
    this.port.onmessage = event => {
      if (event.data === 'flush') { this.encoder.flush(); this.port.postMessage('flushed'); }
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      this.encoder.push(mono);
    }
    return true;
  }
}
registerProcessor('meeting-assistant', MeetingAudio);
