/**
 * Standards §6 microphone capture fallback.
 *
 * Input render quanta are aggregated into exact 20 ms mono frames. PCM storage
 * is preallocated and transferred through a bounded pool; when the main thread
 * cannot recycle storage quickly enough, capture drops and reports frames
 * rather than allowing latency or memory to grow without limit.
 */

const FRAME_SAMPLES = 960;
const BUFFER_POOL_SIZE = 8;

class RealFabricCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.available = [];
    for (let index = 0; index < BUFFER_POOL_SIZE; index += 1) {
      this.available.push(new Float32Array(FRAME_SAMPLES));
    }
    this.current = this.available.pop() ?? null;
    this.offset = 0;
    this.frameStart = 0;
    this.droppedSamples = 0;
    this.closed = false;
    this.port.onmessage = (event) => this.handle(event.data);
  }

  handle(message) {
    if (message?.type === "recycle" && message.buffer instanceof ArrayBuffer) {
      if (this.available.length < BUFFER_POOL_SIZE) {
        this.available.push(new Float32Array(message.buffer));
      }
      return;
    }
    if (message?.type === "close") this.closed = true;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (output?.[0]) output[0].fill(0);
    const frames = input?.[0]?.length ?? 0;

    for (let frame = 0; frame < frames; frame += 1) {
      if (!this.current) {
        this.current = this.available.pop() ?? null;
        this.offset = 0;
      }
      if (!this.current) {
        this.droppedSamples += 1;
        continue;
      }
      if (this.offset === 0) this.frameStart = currentFrame + frame;

      let sample = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        sample += input[channel][frame] ?? 0;
      }
      this.current[this.offset] = sample / Math.max(1, input.length);
      this.offset += 1;

      if (this.offset === FRAME_SAMPLES) {
        const complete = this.current;
        this.current = this.available.pop() ?? null;
        this.offset = 0;
        const droppedFrames = Math.floor(this.droppedSamples / FRAME_SAMPLES);
        this.droppedSamples %= FRAME_SAMPLES;
        this.port.postMessage(
          {
            type: "frame",
            buffer: complete.buffer,
            timestamp: (this.frameStart / sampleRate) * 1_000_000,
            droppedFrames,
          },
          [complete.buffer],
        );
      }
    }

    return !this.closed;
  }
}

registerProcessor("real-fabric-capture", RealFabricCapture);
