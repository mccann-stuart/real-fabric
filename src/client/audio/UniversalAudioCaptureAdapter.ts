import { AUDIO_FRAME_DURATION_MS } from "./frame";

export const CAPTURE_SAMPLE_RATE = 48_000;
export const CAPTURE_FRAME_SAMPLES = 960;
const CAPTURE_WORKLET_URL = "/audio/capture-worklet.js";
const CAPTURE_PROCESSOR_NAME = "real-fabric-capture";

export type CapturePath = "track_processor" | "audio_worklet";

export interface CaptureSupport {
  available: boolean;
  path: CapturePath | null;
  reason: string;
}

export interface CaptureCallbacks {
  /** The frame is valid only for the duration of this synchronous callback. */
  onFrame: (frame: AudioData) => void;
  onError: (error: Error) => void;
}

export interface AudioCaptureAdapter {
  readonly path: CapturePath;
  start(stream: MediaStream, callbacks: CaptureCallbacks): Promise<void>;
  stop(): Promise<void>;
}

interface AudioDataReader {
  read(): Promise<{ done: boolean; value?: AudioData }>;
  cancel(): Promise<void>;
}

interface TrackProcessorConstructor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<AudioData> };
}

interface CaptureEnvironment {
  MediaStreamTrackProcessor?: TrackProcessorConstructor;
  AudioContext?: typeof AudioContext;
  AudioWorkletNode?: typeof AudioWorkletNode;
  AudioData?: typeof AudioData;
}

function browserCaptureEnvironment(): CaptureEnvironment {
  const environment = globalThis as unknown as CaptureEnvironment;
  return {
    ...(environment.MediaStreamTrackProcessor
      ? { MediaStreamTrackProcessor: environment.MediaStreamTrackProcessor }
      : {}),
    ...(environment.AudioContext ? { AudioContext: environment.AudioContext } : {}),
    ...(environment.AudioWorkletNode ? { AudioWorkletNode: environment.AudioWorkletNode } : {}),
    ...(environment.AudioData ? { AudioData: environment.AudioData } : {}),
  };
}

/**
 * Reports the concrete capture path this browser can run. This is capability
 * evidence only; it does not make the browser an accepted H3 configuration.
 */
export function inspectCaptureSupport(
  environment: CaptureEnvironment = browserCaptureEnvironment(),
): CaptureSupport {
  if (!environment.AudioData) {
    return {
      available: false,
      path: null,
      reason: "WebCodecs AudioData is not exposed by this browser.",
    };
  }
  if (environment.MediaStreamTrackProcessor) {
    return {
      available: true,
      path: "track_processor",
      reason: "MediaStreamTrackProcessor capture is available.",
    };
  }
  if (environment.AudioContext && environment.AudioWorkletNode) {
    return {
      available: true,
      path: "audio_worklet",
      reason: "AudioWorklet microphone capture is available.",
    };
  }
  return {
    available: false,
    path: null,
    reason:
      "Neither MediaStreamTrackProcessor nor AudioWorklet microphone capture is exposed by this browser.",
  };
}

export function createAudioCaptureAdapter(
  environment: CaptureEnvironment = browserCaptureEnvironment(),
): AudioCaptureAdapter {
  const support = inspectCaptureSupport(environment);
  if (!support.available || !support.path || !environment.AudioData) {
    throw new Error(support.reason);
  }
  if (support.path === "track_processor" && environment.MediaStreamTrackProcessor) {
    return new TrackProcessorCaptureAdapter(
      environment.MediaStreamTrackProcessor,
      environment.AudioData,
    );
  }
  if (environment.AudioContext && environment.AudioWorkletNode) {
    return new WorkletCaptureAdapter(
      environment.AudioContext,
      environment.AudioWorkletNode,
      environment.AudioData,
    );
  }
  throw new Error("The selected microphone capture path is no longer available.");
}

/**
 * Turns arbitrary capture quanta into exact 20 ms media frames. Its partial
 * storage is fixed at one frame; emitted storage is owned by the consumer.
 */
export class PcmFrameAssembler {
  private readonly pending = new Float32Array(CAPTURE_FRAME_SAMPLES);
  private pendingSamples = 0;
  private nextTimestamp = 0;
  private hasTimestamp = false;

  push(
    samples: Float32Array,
    timestamp: number,
    onFrame: (samples: Float32Array, timestamp: number) => void,
  ): void {
    if (!this.hasTimestamp) {
      this.nextTimestamp = Number.isFinite(timestamp) ? Math.max(0, timestamp) : 0;
      this.hasTimestamp = true;
    }

    let sourceOffset = 0;
    while (sourceOffset < samples.length) {
      const copied = Math.min(
        CAPTURE_FRAME_SAMPLES - this.pendingSamples,
        samples.length - sourceOffset,
      );
      this.pending.set(samples.subarray(sourceOffset, sourceOffset + copied), this.pendingSamples);
      this.pendingSamples += copied;
      sourceOffset += copied;

      if (this.pendingSamples === CAPTURE_FRAME_SAMPLES) {
        onFrame(this.pending.slice(), this.nextTimestamp);
        this.pendingSamples = 0;
        this.nextTimestamp += AUDIO_FRAME_DURATION_MS * 1_000;
      }
    }
  }

  reset(): void {
    this.pending.fill(0);
    this.pendingSamples = 0;
    this.nextTimestamp = 0;
    this.hasTimestamp = false;
  }
}

class TrackProcessorCaptureAdapter implements AudioCaptureAdapter {
  readonly path = "track_processor" as const;
  private reader: AudioDataReader | null = null;
  private readonly assembler = new PcmFrameAssembler();

  constructor(
    private readonly Processor: TrackProcessorConstructor,
    private readonly AudioDataConstructor: typeof AudioData,
  ) {}

  async start(stream: MediaStream, callbacks: CaptureCallbacks): Promise<void> {
    if (this.reader) throw new Error("The track-processor capture path is already active.");
    const track = requireAudioTrack(stream);
    const processor = new this.Processor({ track });
    this.reader = processor.readable.getReader() as unknown as AudioDataReader;
    void this.pump(callbacks);
  }

  private async pump(callbacks: CaptureCallbacks): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    while (this.reader === reader) {
      let result: { done: boolean; value?: AudioData };
      try {
        result = await reader.read();
      } catch (error) {
        if (this.reader === reader) callbacks.onError(asError(error, "Capture read failed."));
        return;
      }
      if (result.done || !result.value) return;
      const data = result.value;
      if (this.reader !== reader) {
        data.close();
        return;
      }
      try {
        if (data.sampleRate !== CAPTURE_SAMPLE_RATE) {
          throw new Error(
            `The microphone produced ${data.sampleRate} Hz audio; exact ${CAPTURE_SAMPLE_RATE} Hz capture is required.`,
          );
        }
        const mono = copyMono(data);
        this.assembler.push(mono, data.timestamp, (samples, timestamp) => {
          deliverFrame(this.AudioDataConstructor, samples, timestamp, callbacks);
        });
      } catch (error) {
        callbacks.onError(asError(error, "Capture framing failed."));
      } finally {
        data.close();
      }
    }
  }

  async stop(): Promise<void> {
    const reader = this.reader;
    this.reader = null;
    this.assembler.reset();
    try {
      await reader?.cancel();
    } catch {
      // A cancelled reader on a stopped track is expected during teardown.
    }
  }
}

interface WorkletFrameMessage {
  type: "frame";
  buffer: ArrayBuffer;
  timestamp: number;
  droppedFrames: number;
}

class WorkletCaptureAdapter implements AudioCaptureAdapter {
  readonly path = "audio_worklet" as const;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private callbacks: CaptureCallbacks | null = null;

  constructor(
    private readonly AudioContextConstructor: typeof AudioContext,
    private readonly AudioWorkletNodeConstructor: typeof AudioWorkletNode,
    private readonly AudioDataConstructor: typeof AudioData,
  ) {}

  async start(stream: MediaStream, callbacks: CaptureCallbacks): Promise<void> {
    if (this.context) throw new Error("The AudioWorklet capture path is already active.");
    requireAudioTrack(stream);
    const context = new this.AudioContextConstructor({
      sampleRate: CAPTURE_SAMPLE_RATE,
      latencyHint: "interactive",
    });
    this.context = context;
    this.callbacks = callbacks;
    try {
      if (context.sampleRate !== CAPTURE_SAMPLE_RATE) {
        throw new Error(
          `The browser opened capture at ${context.sampleRate} Hz; exact ${CAPTURE_SAMPLE_RATE} Hz capture is required.`,
        );
      }
      await context.audioWorklet.addModule(CAPTURE_WORKLET_URL);
      const node = new this.AudioWorkletNodeConstructor(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      const source = context.createMediaStreamSource(stream);
      const sink = context.createGain();
      sink.gain.value = 0;
      node.port.onmessage = (event: MessageEvent<WorkletFrameMessage>) => this.receive(event.data);
      node.onprocessorerror = () => {
        this.callbacks?.onError(new Error("The AudioWorklet microphone processor stopped."));
      };
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      this.source = source;
      this.node = node;
      this.sink = sink;
      if (context.state === "suspended") await context.resume();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private receive(message: WorkletFrameMessage): void {
    if (message?.type !== "frame") return;
    const node = this.node;
    if (!node) return;
    try {
      if (message.droppedFrames > 0) {
        this.callbacks?.onError(
          new Error(
            `AudioWorklet capture dropped ${message.droppedFrames} frame${message.droppedFrames === 1 ? "" : "s"} because its bounded buffer pool was exhausted.`,
          ),
        );
      }
      deliverFrame(
        this.AudioDataConstructor,
        new Float32Array(message.buffer),
        message.timestamp,
        this.callbacks,
      );
    } catch (error) {
      this.callbacks?.onError(asError(error, "AudioWorklet capture framing failed."));
    } finally {
      node.port.postMessage({ type: "recycle", buffer: message.buffer }, [message.buffer]);
    }
  }

  async stop(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.callbacks = null;
    this.node?.port.postMessage({ type: "close" });
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.source = null;
    this.node = null;
    this.sink = null;
    if (context && context.state !== "closed") await context.close();
  }
}

function requireAudioTrack(stream: MediaStream): MediaStreamTrack {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("The microphone stream carries no audio track.");
  return track;
}

function copyMono(data: AudioData): Float32Array {
  const mono = new Float32Array(data.numberOfFrames);
  const plane = new Float32Array(data.numberOfFrames);
  for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
    data.copyTo(plane, {
      planeIndex: channel,
      frameCount: data.numberOfFrames,
      format: "f32-planar",
    });
    for (let index = 0; index < mono.length; index += 1) {
      mono[index] = (mono[index] ?? 0) + (plane[index] ?? 0) / data.numberOfChannels;
    }
  }
  return mono;
}

function deliverFrame(
  AudioDataConstructor: typeof AudioData,
  samples: Float32Array,
  timestamp: number,
  callbacks: CaptureCallbacks | null,
): void {
  if (!callbacks) return;
  const frame = new AudioDataConstructor({
    format: "f32-planar",
    sampleRate: CAPTURE_SAMPLE_RATE,
    numberOfFrames: CAPTURE_FRAME_SAMPLES,
    numberOfChannels: 1,
    timestamp,
    data: samples.buffer as ArrayBuffer,
  });
  try {
    callbacks.onFrame(frame);
  } finally {
    frame.close();
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
