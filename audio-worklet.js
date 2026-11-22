"use strict";
class JarvisPcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(4800); this.offset = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const input = channels[0];
    let cursor = 0;
    while (cursor < input.length) {
      const count = Math.min(this.buffer.length - this.offset, input.length - cursor);
      this.buffer.set(input.subarray(cursor, cursor + count), this.offset);
      this.offset += count; cursor += count;
      if (this.offset === this.buffer.length) {
        const block = this.buffer;
        this.port.postMessage(block, [block.buffer]);
        this.buffer = new Float32Array(4800); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("jarvis-pcm-tap", JarvisPcmTap);
