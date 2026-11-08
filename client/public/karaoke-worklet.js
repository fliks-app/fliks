// Collects the mic's 128-sample quanta into 1024-sample blocks for the main thread.
class KaraokeCapture extends AudioWorkletProcessor {
  buf = new Float32Array(1024);
  n = 0;
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('karaoke-capture', KaraokeCapture);
