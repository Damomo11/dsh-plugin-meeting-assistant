// lite/pcm.mjs — 浏览器 AudioWorklet 用的流式重采样器：任意输入采样率 → 单声道 16k PCM16LE。
// 移植自 src/voice/pcm.ts（逻辑保持一致，改成无类型的 .mjs 以便 worklet 直接加载）。

export class PcmEncoder {
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
