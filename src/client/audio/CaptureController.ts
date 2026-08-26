import { type Measurement, measured, notExposed } from "../../shared/measurement";
import { AUDIO_FRAME_DURATION_MS } from "./frame";
import {
  type AudioCaptureAdapter,
  CAPTURE_FRAME_SAMPLES,
  CAPTURE_SAMPLE_RATE,
  type CapturePath,
  createAudioCaptureAdapter,
  inspectCaptureSupport,
} from "./UniversalAudioCaptureAdapter";
import { VoiceActivityDetector } from "./VoiceActivityDetector";

/**
 * FR3 capture and encode: mono voice, Opus at 48 kHz and 32 kbit/s in 20 ms
 * frames, DTX where the encoder exposes it.
 *
 * DTX is what makes open membership affordable — a silent participant costs
 * almost nothing across the relay — so whether it is actually on is reported
 * rather than assumed.
 */

export const DEFAULT_BITRATE = 32_000;

export interface CaptureOptions {
  /** Presenter-adjustable per FR3. */
  bitrate?: number;
  onEncodedFrame: (frame: EncodedAudioChunk) => void;
  /** H6: fires the instant this human starts speaking. */
  onOnset?: () => void;
  onRelease?: () => void;
  onError?: (error: Error) => void;
}

export class CaptureController {
  private stream: MediaStream | null = null;
  private encoder: AudioEncoder | null = null;
  private adapter: AudioCaptureAdapter | null = null;
  private readonly detector = new VoiceActivityDetector();
  private dtx: Measurement<boolean> = notExposed("Capture has not started.");
  private path: Measurement<CapturePath> = notExposed("Capture has not started.");
  private encodedFrames = 0;
  private encodedBytes = 0;
  private draining = false;

  /**
   * Starts capture and encode. Throws a specific error for each §10 capture
   * failure rather than degrading to a working-looking silent state.
   */
  async start(options: CaptureOptions): Promise<MediaStream> {
    if (this.stream || this.encoder) {
      throw new Error("Microphone capture is already active for this participant.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not exposed by this browser.");
    }
    if (!("AudioEncoder" in globalThis)) {
      throw new Error("WebCodecs AudioEncoder is not exposed by this browser.");
    }
    const support = inspectCaptureSupport();
    if (!support.available) throw new Error(support.reason);

    // H4: echo cancellation is a defence, not the mechanism. Headphones are.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: CAPTURE_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    try {
      const bitrate = options.bitrate ?? DEFAULT_BITRATE;
      this.dtx = await probeDtx(bitrate);
      const configuration = buildConfiguration(bitrate, this.dtx);

      this.encoder = new AudioEncoder({
        output: (chunk) => {
          this.encodedFrames += 1;
          this.encodedBytes += chunk.byteLength;
          options.onEncodedFrame(chunk);
        },
        error: (error) => {
          // Never swallowed: an encoder that dies must surface as a failure state.
          options.onError?.(new Error(`Opus encoder failed: ${error.name}`));
        },
      });
      this.encoder.configure(configuration);

      const scratch = new Float32Array(CAPTURE_FRAME_SAMPLES);
      this.adapter = createAudioCaptureAdapter();
      await this.adapter.start(this.stream, {
        onFrame: (data) => {
          try {
            data.copyTo(scratch, { planeIndex: 0, frameCount: CAPTURE_FRAME_SAMPLES });
            const event = this.detector.observe(scratch);
            if (event === "onset") options.onOnset?.();
            if (event === "release") options.onRelease?.();
            this.encoder?.encode(data);
          } catch (error) {
            options.onError?.(error instanceof Error ? error : new Error("Capture encode failed."));
          }
        },
        onError: (error) => options.onError?.(error),
      });
      this.path = measured(this.adapter.path);
      this.encodedFrames = 0;
      this.encodedBytes = 0;
      return this.stream;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** FR3: whether DTX is actually enabled, never a claim that it is. */
  dtxEnabled(): Measurement<boolean> {
    return this.dtx;
  }

  capturePath(): Measurement<CapturePath> {
    return this.path;
  }

  get speaking(): boolean {
    return this.detector.isSpeaking;
  }

  get level(): number {
    return this.detector.level;
  }

  /** Object rate is roughly (active speakers x 50) per second, per §6.3. */
  encodedObjectStats(): { frames: Measurement<number>; meanBytes: Measurement<number> } {
    if (this.encodedFrames === 0) {
      const reason = "No Opus frame has been encoded yet.";
      return { frames: notExposed(reason), meanBytes: notExposed(reason) };
    }
    return {
      frames: measured(this.encodedFrames),
      meanBytes: measured(this.encodedBytes / this.encodedFrames),
    };
  }

  async stop(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const adapter = this.adapter;
    this.adapter = null;
    try {
      await adapter?.stop();
    } catch {
      // A cancelled reader on a stopped track is expected during teardown.
    }
    try {
      if (this.encoder?.state === "configured") await this.encoder.flush();
    } catch {
      // Flushing a failed encoder is best-effort; teardown must still complete.
    } finally {
      if (this.encoder?.state !== "closed") this.encoder?.close();
      this.encoder = null;
      for (const track of this.stream?.getTracks() ?? []) track.stop();
      this.stream = null;
      this.detector.reset();
      this.dtx = notExposed("Capture has stopped.");
      this.path = notExposed("Capture has stopped.");
      this.draining = false;
    }
  }
}

interface OpusEncoderConfig extends AudioEncoderConfig {
  opus?: { frameDuration?: number; usedtx?: boolean };
}

function buildConfiguration(bitrate: number, dtx: Measurement<boolean>): OpusEncoderConfig {
  return {
    codec: "opus",
    sampleRate: CAPTURE_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate,
    opus: {
      // Microseconds, per the WebCodecs Opus registration.
      frameDuration: AUDIO_FRAME_DURATION_MS * 1_000,
      ...(dtx.exposed && dtx.value ? { usedtx: true } : {}),
    },
  };
}

async function probeDtx(bitrate: number): Promise<Measurement<boolean>> {
  const candidate: OpusEncoderConfig = {
    codec: "opus",
    sampleRate: CAPTURE_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate,
    opus: { frameDuration: AUDIO_FRAME_DURATION_MS * 1_000, usedtx: true },
  };
  try {
    const result = await AudioEncoder.isConfigSupported(candidate);
    if (!result.supported) {
      return measured(false);
    }
    // Chromium echoes back the accepted config. If it dropped `usedtx`, the
    // encoder does not support it and claiming otherwise would be a fiction.
    const echoed = result.config as OpusEncoderConfig | undefined;
    if (echoed?.opus && echoed.opus.usedtx !== true) return measured(false);
    return measured(true);
  } catch {
    return notExposed("This browser does not report whether Opus DTX is supported.");
  }
}
