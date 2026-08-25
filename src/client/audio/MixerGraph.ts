import { type Measurement, measured, notExposed } from "../../shared/measurement";

/**
 * H2 and FR3: every subscribed track decodes into its own buffer, and all of
 * them are summed in a single AudioWorklet against one output clock. This class
 * is the main-thread side of that — the only mixing point in the build.
 */

const WORKLET_URL = "/audio/mixer-worklet.js";
const PROCESSOR_NAME = "real-fabric-mixer";
export const MEDIA_SAMPLE_RATE = 48_000;

export interface TrackMixStats {
  trackId: string;
  bufferedSamples: number;
  underruns: number;
  ratio: number;
}

interface WorkletStatsMessage {
  type: "stats";
  at: number;
  tracks: TrackMixStats[];
}

export class MixerGraph {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private removeUnlockListeners: (() => void) | null = null;
  private tracks = new Set<string>();
  private latest: TrackMixStats[] = [];
  private startedAt: number | null = null;

  async start(): Promise<void> {
    if (this.closed) return;
    if (this.context) {
      this.requestResume();
      return;
    }
    if (this.starting) return this.starting;

    const attempt = this.startOnce();
    this.starting = attempt;
    try {
      await attempt;
    } finally {
      if (this.starting === attempt) this.starting = null;
    }
  }

  private async startOnce(): Promise<void> {
    const context = new AudioContext({
      sampleRate: MEDIA_SAMPLE_RATE,
      latencyHint: "interactive",
    });
    try {
      await context.audioWorklet.addModule(WORKLET_URL);
      if (this.closed) {
        await context.close().catch(() => undefined);
        return;
      }
      const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (event: MessageEvent<WorkletStatsMessage>) => {
        if (event.data?.type === "stats") this.latest = event.data.tracks;
      };
      node.connect(context.destination);

      this.context = context;
      this.node = node;
      this.startedAt = Date.now();
      for (const trackId of this.tracks) this.post({ type: "add_track", trackId });

      // Chrome may suspend a new AudioContext after the asynchronous room
      // join has consumed the entry click's activation. Do not let that block
      // getUserMedia; retry immediately and on the next in-page interaction.
      this.installUnlockListeners();
      this.requestResume();
    } catch (error) {
      if (context.state !== "closed") await context.close().catch(() => undefined);
      throw error;
    }
  }

  /** Capture becoming active can make an immediate playback resume possible. */
  resume(): void {
    this.requestResume();
  }

  get running(): boolean {
    return this.context?.state === "running";
  }

  addTrack(trackId: string): void {
    if (this.tracks.has(trackId)) return;
    this.tracks.add(trackId);
    this.post({ type: "add_track", trackId });
  }

  removeTrack(trackId: string): void {
    if (!this.tracks.delete(trackId)) return;
    this.post({ type: "remove_track", trackId });
    this.latest = this.latest.filter((entry) => entry.trackId !== trackId);
  }

  /** Decoded PCM for one track. Transferred, never copied into shared state. */
  pushSamples(trackId: string, samples: Float32Array): void {
    if (!this.tracks.has(trackId)) this.addTrack(trackId);
    this.post({ type: "samples", trackId, samples }, [samples.buffer]);
  }

  /** FR3 drift correction, computed by DriftEstimator on this thread. */
  setRatio(trackId: string, ratio: number): void {
    this.post({ type: "ratio", trackId, ratio });
  }

  /** FR3: rebuild a track's buffer, used when drift leaves correction range. */
  flush(trackId: string): void {
    this.post({ type: "flush", trackId });
  }

  trackCount(): number {
    return this.tracks.size;
  }

  stats(): TrackMixStats[] {
    return [...this.latest];
  }

  /** Worst buffer depth across tracks, for the presenter strip and the ladder. */
  worstBufferMs(): Measurement<number> {
    if (!this.running) return notExposed("The mixing graph is not running.");
    if (this.latest.length === 0) {
      return notExposed("No subscribed track has reported a buffer depth yet.");
    }
    const worst = this.latest.reduce(
      (maximum, entry) => Math.max(maximum, entry.bufferedSamples),
      0,
    );
    return measured((worst / MEDIA_SAMPLE_RATE) * 1_000);
  }

  totalUnderruns(): Measurement<number> {
    if (!this.running) return notExposed("The mixing graph is not running.");
    return measured(this.latest.reduce((sum, entry) => sum + entry.underruns, 0));
  }

  /** Browser-reported output latency, where the browser exposes it (H15). */
  outputLatencyMs(): Measurement<number> {
    const latency = this.context?.outputLatency;
    if (typeof latency !== "number" || Number.isNaN(latency)) {
      return notExposed("This browser does not report AudioContext output latency.");
    }
    return measured(latency * 1_000);
  }

  uptimeMs(): Measurement<number> {
    if (this.startedAt === null) return notExposed("The mixing graph has not started.");
    return measured(Date.now() - this.startedAt);
  }

  /** §4.4: leaving closes the worklet, the context and every track buffer. */
  async close(): Promise<void> {
    this.closed = true;
    this.removeUnlockListeners?.();
    this.removeUnlockListeners = null;
    this.post({ type: "close" });
    this.node?.disconnect();
    this.node = null;
    this.tracks.clear();
    this.latest = [];
    this.startedAt = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }

  private post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    this.node?.port.postMessage(message, transfer);
  }

  private requestResume(): void {
    const context = this.context;
    if (context?.state !== "suspended") return;
    void context.resume().then(
      () => {
        if (context.state !== "running") return;
        this.removeUnlockListeners?.();
        this.removeUnlockListeners = null;
      },
      () => undefined,
    );
  }

  private installUnlockListeners(): void {
    if (this.removeUnlockListeners || typeof document === "undefined") return;
    const unlock = () => this.requestResume();
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    this.removeUnlockListeners = () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }
}
