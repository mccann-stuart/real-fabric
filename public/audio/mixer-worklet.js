/**
 * Real Fabric mixing worklet.
 *
 * H2 and FR3: this is the only place decoded tracks are summed, it runs on the
 * listener's machine, and it sums against one output clock. The relay and the
 * room service never see a mixed stream.
 *
 * Deliberately thin. Every decision — jitter target, drift ratio, which tracks
 * to release — is made in typed, unit-tested code on the main thread and
 * arrives here as a number. Audio-thread code that makes decisions is code
 * nobody can test.
 *
 * Served as a static same-origin asset so it satisfies `script-src 'self'`.
 * A blob: worklet would need the content security policy widened.
 */

const RING_SAMPLES = 48_000; // one second at the 48 kHz media clock
const COMFORT_NOISE_GAIN = 0.0015;
/** Underrun run-length after which a track is treated as genuinely absent. */
const COMFORT_NOISE_QUANTA = 25; // ~64 ms of 128-sample quanta
const REPORT_INTERVAL_QUANTA = 40;

class TrackBuffer {
  constructor() {
    this.ring = new Float32Array(RING_SAMPLES);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;
    /** Drift correction. Above 1 reads faster, pulling a slow sender back. */
    this.ratio = 1;
    this.underruns = 0;
    this.consecutiveUnderrunQuanta = 0;
    this.everWritten = false;
  }

  write(samples) {
    this.everWritten = true;
    for (let index = 0; index < samples.length; index += 1) {
      this.ring[this.writeIndex] = samples[index];
      this.writeIndex = (this.writeIndex + 1) % RING_SAMPLES;
    }
    // Overwriting unread audio is bounded loss, not unbounded growth (H13).
    this.available = Math.min(RING_SAMPLES, this.available + samples.length);
  }

  /** Returns null when there is nothing to read, so the caller can conceal. */
  read() {
    if (this.available < 2) return null;
    const base = Math.floor(this.readIndex);
    const fraction = this.readIndex - base;
    const first = this.ring[base % RING_SAMPLES];
    const second = this.ring[(base + 1) % RING_SAMPLES];
    const value = first + (second - first) * fraction;

    this.readIndex += this.ratio;
    this.available -= Math.floor(this.readIndex) - base;
    if (this.readIndex >= RING_SAMPLES) this.readIndex -= RING_SAMPLES;
    return value;
  }

  flush() {
    this.ring.fill(0);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;
  }
}

class RealFabricMixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracks = new Map();
    this.quanta = 0;
    this.closed = false;
    this.port.onmessage = (event) => this.handle(event.data);
  }

  handle(message) {
    switch (message?.type) {
      case "add_track":
        if (!this.tracks.has(message.trackId)) {
          this.tracks.set(message.trackId, new TrackBuffer());
        }
        break;
      case "remove_track":
        this.tracks.delete(message.trackId);
        break;
      case "samples": {
        const track = this.tracks.get(message.trackId);
        if (track) track.write(message.samples);
        break;
      }
      case "ratio": {
        const track = this.tracks.get(message.trackId);
        // Clamped on the main thread; clamped again so a bad ratio cannot
        // turn into an audible artefact on the audio thread.
        if (track) track.ratio = Math.min(1.05, Math.max(0.95, message.ratio));
        break;
      }
      case "flush": {
        const track = this.tracks.get(message.trackId);
        if (track) track.flush();
        break;
      }
      case "close":
        this.closed = true;
        break;
      default:
        break;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return !this.closed;
    const channel = output[0];
    const frames = channel.length;

    for (let frame = 0; frame < frames; frame += 1) channel[frame] = 0;

    for (const track of this.tracks.values()) {
      let readAny = false;
      for (let frame = 0; frame < frames; frame += 1) {
        const sample = track.read();
        if (sample === null) continue;
        readAny = true;
        channel[frame] += sample;
      }

      if (readAny) {
        track.consecutiveUnderrunQuanta = 0;
        continue;
      }

      track.underruns += 1;
      track.consecutiveUnderrunQuanta += 1;
      // FR3: sustained loss produces comfort noise, not silence — but only for
      // a track that has actually carried audio, and only until it is clearly
      // just quiet rather than broken. DTX means silence is normal here.
      if (track.everWritten && track.consecutiveUnderrunQuanta < COMFORT_NOISE_QUANTA) {
        for (let frame = 0; frame < frames; frame += 1) {
          channel[frame] += (Math.random() * 2 - 1) * COMFORT_NOISE_GAIN;
        }
      }
    }

    // Sum, then bound. Peak limiting rather than per-track attenuation keeps a
    // single speaker at full level regardless of how many people are present.
    for (let frame = 0; frame < frames; frame += 1) {
      const value = channel[frame];
      if (value > 1) channel[frame] = 1;
      else if (value < -1) channel[frame] = -1;
    }

    // Copy mono to any remaining output channels.
    for (let index = 1; index < output.length; index += 1) output[index].set(channel);

    this.quanta += 1;
    if (this.quanta % REPORT_INTERVAL_QUANTA === 0) this.report();
    return !this.closed;
  }

  report() {
    const tracks = [];
    for (const [trackId, track] of this.tracks) {
      tracks.push({
        trackId,
        bufferedSamples: track.available,
        underruns: track.underruns,
        ratio: track.ratio,
      });
    }
    this.port.postMessage({ type: "stats", at: currentTime, tracks });
  }
}

registerProcessor("real-fabric-mixer", RealFabricMixer);
