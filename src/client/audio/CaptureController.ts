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
  private muted = false;

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
      const support = await probeOpusEncoderSupport(bitrate);
      if (!support.supported || !support.configuration) throw new Error(support.reason);
      this.dtx = support.dtx;
      const configuration = support.configuration;

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
      this.setMuted(this.muted);
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

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  get isMuted(): boolean {
    return this.muted;
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

export interface OpusEncoderConfig extends AudioEncoderConfig {
  opus?: {
    frameDuration?: number;
    usedtx?: boolean;
    application?: "voip" | "audio" | "lowdelay";
    signal?: "auto" | "music" | "voice";
  };
}

export interface OpusEncoderProbe {
  supported: boolean;
  configuration: OpusEncoderConfig | null;
  dtx: Measurement<boolean>;
  application: Measurement<"voip">;
  signal: Measurement<"voice">;
  reason: string;
}

export async function probeOpusEncoderSupport(
  bitrate = DEFAULT_BITRATE,
): Promise<OpusEncoderProbe> {
  if (!("AudioEncoder" in globalThis)) {
    const reason = "WebCodecs AudioEncoder is not exposed by this browser.";
    return unsupportedOpusProbe(reason);
  }
  const required: OpusEncoderConfig = {
    codec: "opus",
    sampleRate: CAPTURE_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate,
  };
  try {
    const result = await AudioEncoder.isConfigSupported(required);
    if (!result.supported) {
      return unsupportedOpusProbe(
        "This browser rejected 48 kHz mono Opus at 32 kbit/s with 20 ms input frames.",
      );
    }

    // Optional Opus controls are negotiated independently. A browser that
    // rejects DTX or a voice hint can still carry the required Opus stream;
    // unsupported values are omitted rather than making encode unavailable.
    const opus: NonNullable<OpusEncoderConfig["opus"]> = {};
    const frameDuration = AUDIO_FRAME_DURATION_MS * 1_000;
    if (await acceptsOpusOption(required, opus, "frameDuration", frameDuration)) {
      opus.frameDuration = frameDuration;
    }
    if (await acceptsOpusOption(required, opus, "application", "voip")) {
      opus.application = "voip";
    }
    if (await acceptsOpusOption(required, opus, "signal", "voice")) {
      opus.signal = "voice";
    }
    if (await acceptsOpusOption(required, opus, "usedtx", true)) {
      opus.usedtx = true;
    }

    return {
      supported: true,
      configuration: {
        codec: "opus",
        sampleRate: CAPTURE_SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate,
        ...(Object.keys(opus).length > 0 ? { opus } : {}),
      },
      dtx:
        opus.usedtx === true
          ? measured(true)
          : notExposed("The accepted Opus configuration did not report DTX."),
      application:
        opus.application === "voip"
          ? measured("voip")
          : notExposed("The accepted Opus configuration did not report the VoIP application hint."),
      signal:
        opus.signal === "voice"
          ? measured("voice")
          : notExposed("The accepted Opus configuration did not report the voice signal hint."),
      reason: "Opus encode is available; optional DTX and voice hints are reported separately.",
    };
  } catch {
    return unsupportedOpusProbe(
      "This browser could not evaluate the required Opus encoder configuration.",
    );
  }
}

async function acceptsOpusOption<K extends keyof NonNullable<OpusEncoderConfig["opus"]>>(
  required: OpusEncoderConfig,
  accepted: NonNullable<OpusEncoderConfig["opus"]>,
  key: K,
  value: NonNullable<OpusEncoderConfig["opus"]>[K],
): Promise<boolean> {
  try {
    const result = await AudioEncoder.isConfigSupported({
      ...required,
      opus: { ...accepted, [key]: value },
    });
    const echoed = (result.config as OpusEncoderConfig | undefined)?.opus;
    const echoedOptions = echoed as Record<string, unknown> | undefined;
    const preservesAccepted = Object.entries(accepted).every(
      ([acceptedKey, acceptedValue]) => echoedOptions?.[acceptedKey] === acceptedValue,
    );
    return result.supported === true && preservesAccepted && echoedOptions?.[String(key)] === value;
  } catch {
    return false;
  }
}

function unsupportedOpusProbe(reason: string): OpusEncoderProbe {
  return {
    supported: false,
    configuration: null,
    dtx: notExposed(reason),
    application: notExposed(reason),
    signal: notExposed(reason),
    reason,
  };
}
