import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureController, DEFAULT_BITRATE } from "../src/client/audio/CaptureController";
import {
  type AudioCaptureAdapter,
  CAPTURE_FRAME_SAMPLES,
  CAPTURE_SAMPLE_RATE,
  type CaptureCallbacks,
} from "../src/client/audio/UniversalAudioCaptureAdapter";

// Mock UniversalAudioCaptureAdapter module
let mockAdapterCallbacks: CaptureCallbacks | null = null;
let mockAdapterStartImpl:
  | ((stream: MediaStream, callbacks: CaptureCallbacks) => Promise<void>)
  | null = null;
let mockAdapterStopImpl: (() => Promise<void>) | null = null;

vi.mock("../src/client/audio/UniversalAudioCaptureAdapter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/client/audio/UniversalAudioCaptureAdapter")>();
  return {
    ...actual,
    inspectCaptureSupport: vi.fn().mockImplementation(() => actual.inspectCaptureSupport()),
    createAudioCaptureAdapter: vi.fn().mockImplementation(() => {
      const adapter: AudioCaptureAdapter = {
        path: "track_processor",
        async start(stream: MediaStream, callbacks: CaptureCallbacks) {
          mockAdapterCallbacks = callbacks;
          if (mockAdapterStartImpl) {
            await mockAdapterStartImpl(stream, callbacks);
          }
        },
        async stop() {
          if (mockAdapterStopImpl) {
            await mockAdapterStopImpl();
          }
        },
      };
      return adapter;
    }),
  };
});

import { inspectCaptureSupport } from "../src/client/audio/UniversalAudioCaptureAdapter";

class MockAudioData {
  format = "f32-planar";
  sampleRate = CAPTURE_SAMPLE_RATE;
  numberOfFrames = CAPTURE_FRAME_SAMPLES;
  numberOfChannels = 1;
  timestamp: number;
  duration: number;
  closed = false;

  constructor(init: { timestamp?: number; duration?: number } = {}) {
    this.timestamp = init.timestamp ?? 1_000;
    this.duration = init.duration ?? 20_000;
  }

  copyTo(destination: Float32Array, _options?: unknown) {
    destination.fill(0.1);
  }

  close() {
    this.closed = true;
  }
}

class MockAudioEncoder {
  static isConfigSupported = vi.fn().mockResolvedValue({
    supported: true,
    config: {
      codec: "opus",
      sampleRate: CAPTURE_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: DEFAULT_BITRATE,
    },
  });

  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  outputCallback: (chunk: EncodedAudioChunk) => void;
  errorCallback: (error: DOMException) => void;

  constructor(init: {
    output: (chunk: EncodedAudioChunk) => void;
    error: (error: DOMException) => void;
  }) {
    this.outputCallback = init.output;
    this.errorCallback = init.error;
  }

  configure(_config: unknown) {
    this.state = "configured";
  }

  encode(_data: unknown) {}

  async flush() {}

  close() {
    this.state = "closed";
  }
}

class MockMediaStreamTrack {
  enabled = true;
  kind = "audio";
  stop = vi.fn();
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()];
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

describe("CaptureController - error handling and boundary conditions", () => {
  const originalAudioEncoder = globalThis.AudioEncoder;
  const originalAudioData = globalThis.AudioData;
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    mockAdapterCallbacks = null;
    mockAdapterStartImpl = null;
    mockAdapterStopImpl = null;

    (globalThis as unknown as Record<string, unknown>).AudioEncoder = MockAudioEncoder;
    (globalThis as unknown as Record<string, unknown>).AudioData = MockAudioData;

    MockAudioEncoder.isConfigSupported.mockReset().mockResolvedValue({
      supported: true,
      config: {
        codec: "opus",
        sampleRate: CAPTURE_SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate: DEFAULT_BITRATE,
      },
    });

    vi.mocked(inspectCaptureSupport).mockReturnValue({
      available: true,
      path: "track_processor",
      reason: "MediaStreamTrackProcessor capture is available.",
    });

    Object.defineProperty(navigator, "mediaDevices", {
      writable: true,
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
      },
    });
  });

  afterEach(() => {
    if (originalAudioEncoder) {
      (globalThis as unknown as Record<string, unknown>).AudioEncoder = originalAudioEncoder;
    } else {
      delete (globalThis as unknown as Record<string, unknown>).AudioEncoder;
    }

    if (originalAudioData) {
      (globalThis as unknown as Record<string, unknown>).AudioData = originalAudioData;
    } else {
      delete (globalThis as unknown as Record<string, unknown>).AudioData;
    }

    Object.defineProperty(navigator, "mediaDevices", {
      writable: true,
      configurable: true,
      value: originalMediaDevices,
    });

    vi.restoreAllMocks();
  });

  describe("start() pre-flight checks and setup errors", () => {
    it("throws when microphone capture is already active", async () => {
      const controller = new CaptureController();
      await controller.start({ onEncodedFrame: () => {} });
      await expect(controller.start({ onEncodedFrame: () => {} })).rejects.toThrow(
        "Microphone capture is already active for this participant.",
      );
      await controller.stop();
    });

    it("throws when getUserMedia is not exposed by browser", async () => {
      Object.defineProperty(navigator, "mediaDevices", {
        writable: true,
        configurable: true,
        value: undefined,
      });
      const controller = new CaptureController();
      await expect(controller.start({ onEncodedFrame: () => {} })).rejects.toThrow(
        "Microphone capture is not exposed by this browser.",
      );
    });

    it("throws when AudioEncoder is not exposed by browser", async () => {
      delete (globalThis as unknown as Record<string, unknown>).AudioEncoder;
      const controller = new CaptureController();
      await expect(controller.start({ onEncodedFrame: () => {} })).rejects.toThrow(
        "WebCodecs AudioEncoder is not exposed by this browser.",
      );
    });

    it("throws when inspectCaptureSupport reports capture unavailable", async () => {
      vi.mocked(inspectCaptureSupport).mockReturnValue({
        available: false,
        path: null,
        reason: "Microphone capture is not supported.",
      });
      const controller = new CaptureController();
      await expect(controller.start({ onEncodedFrame: () => {} })).rejects.toThrow(
        "Microphone capture is not supported.",
      );
    });

    it("cleans up resources via stop() when adapter.start fails", async () => {
      mockAdapterStartImpl = async () => {
        throw new Error("Failed to initialize audio capture adapter.");
      };
      const controller = new CaptureController();
      await expect(controller.start({ onEncodedFrame: () => {} })).rejects.toThrow(
        "Failed to initialize audio capture adapter.",
      );

      expect(controller.dtxEnabled().exposed).toBe(false);
      expect(controller.capturePath().exposed).toBe(false);
    });
  });

  describe("AudioEncoder and adapter callback error handling", () => {
    it("surfaces AudioEncoder error callback to options.onError", async () => {
      const onError = vi.fn();
      const controller = new CaptureController();
      const ref: { encoderInstance: MockAudioEncoder | null } = { encoderInstance: null };

      (globalThis as unknown as Record<string, unknown>).AudioEncoder = class extends (
        MockAudioEncoder
      ) {
        constructor(init: {
          output: (chunk: EncodedAudioChunk) => void;
          error: (error: DOMException) => void;
        }) {
          super(init);
          ref.encoderInstance = this;
        }
      };

      await controller.start({ onEncodedFrame: () => {}, onError });
      expect(ref.encoderInstance).not.toBeNull();

      ref.encoderInstance?.errorCallback(
        new DOMException("Encoding hardware failed", "NotReadableError"),
      );

      expect(onError).toHaveBeenCalledWith(new Error("Opus encoder failed: NotReadableError"));
      await controller.stop();
    });

    it("forwards adapter onError callback to options.onError", async () => {
      const onError = vi.fn();
      const controller = new CaptureController();

      await controller.start({ onEncodedFrame: () => {}, onError });
      expect(mockAdapterCallbacks).not.toBeNull();

      const adapterError = new Error("Worklet frame overflow");
      mockAdapterCallbacks?.onError(adapterError);

      expect(onError).toHaveBeenCalledWith(adapterError);
      await controller.stop();
    });

    it("handles encoder.encode throwing an Error during onFrame, cleans up pending timestamp, and triggers onError", async () => {
      const onError = vi.fn();
      const controller = new CaptureController();
      let encoderEncodeCalled = false;

      const encodeError = new Error("Encoder buffer full");
      (globalThis as unknown as Record<string, unknown>).AudioEncoder = class extends (
        MockAudioEncoder
      ) {
        encode(_data: unknown) {
          encoderEncodeCalled = true;
          throw encodeError;
        }
      };

      await controller.start({ onEncodedFrame: () => {}, onError });
      expect(mockAdapterCallbacks).not.toBeNull();

      const mockFrame = new MockAudioData({ timestamp: 1234 });
      mockAdapterCallbacks?.onFrame(mockFrame as unknown as AudioData);

      expect(encoderEncodeCalled).toBe(true);
      expect(onError).toHaveBeenCalledWith(encodeError);

      const internal = controller as unknown as { pendingEncodeStartedAt: Map<number, number> };
      expect(internal.pendingEncodeStartedAt.has(1234)).toBe(false);

      await controller.stop();
    });

    it("catches non-Error exceptions during onFrame and wraps them in a standard Error (line 151)", async () => {
      const onError = vi.fn();
      const controller = new CaptureController();

      await controller.start({ onEncodedFrame: () => {}, onError });
      expect(mockAdapterCallbacks).not.toBeNull();

      // Create a mock frame whose copyTo throws a non-Error string
      const faultyFrame = {
        timestamp: 5000,
        duration: 20000,
        copyTo: () => {
          throw "Raw string exception from audio buffer copy";
        },
      };

      mockAdapterCallbacks?.onFrame(faultyFrame as unknown as AudioData);

      expect(onError).toHaveBeenCalledTimes(1);
      const reportedError = onError.mock.calls[0]?.[0];
      expect(reportedError).toBeInstanceOf(Error);
      expect(reportedError?.message).toBe("Capture encode failed.");

      await controller.stop();
    });

    it("evicts the oldest pending encode timestamp when capacity exceeds 256 items", async () => {
      const controller = new CaptureController();
      await controller.start({ onEncodedFrame: () => {} });
      expect(mockAdapterCallbacks).not.toBeNull();

      const internal = controller as unknown as { pendingEncodeStartedAt: Map<number, number> };

      // Simulate 257 frames arriving to exceed MAXIMUM_PENDING_ENCODE_TIMINGS (256)
      for (let i = 0; i < 257; i += 1) {
        const frame = new MockAudioData({ timestamp: i * 20_000 });
        mockAdapterCallbacks?.onFrame(frame as unknown as AudioData);
      }

      expect(internal.pendingEncodeStartedAt.size).toBe(256);
      // The oldest timestamp (0) should have been evicted
      expect(internal.pendingEncodeStartedAt.has(0)).toBe(false);
      // The newest timestamp should be present
      expect(internal.pendingEncodeStartedAt.has(256 * 20_000)).toBe(true);

      await controller.stop();
    });

    it("ignores onFrame when encoder is null", async () => {
      const onError = vi.fn();
      const controller = new CaptureController();
      await controller.start({ onEncodedFrame: () => {}, onError });

      const internal = controller as unknown as { encoder: MockAudioEncoder | null };
      internal.encoder = null;

      const mockFrame = new MockAudioData({ timestamp: 100 });
      expect(() => mockAdapterCallbacks?.onFrame(mockFrame as unknown as AudioData)).not.toThrow();

      expect(onError).not.toHaveBeenCalled();
      await controller.stop();
    });

    it("observes voice activity events (onset and release)", async () => {
      const onOnset = vi.fn();
      const onRelease = vi.fn();
      const controller = new CaptureController();

      await controller.start({ onEncodedFrame: () => {}, onOnset, onRelease });

      const internal = controller as unknown as {
        detector: { observe: (scratch: Float32Array) => "onset" | "release" | null };
      };

      // Mock detector returning onset
      vi.spyOn(internal.detector, "observe")
        .mockReturnValueOnce("onset")
        .mockReturnValueOnce("release");

      const mockFrame = new MockAudioData({ timestamp: 100 });
      mockAdapterCallbacks?.onFrame(mockFrame as unknown as AudioData);
      expect(onOnset).toHaveBeenCalledOnce();

      mockAdapterCallbacks?.onFrame(mockFrame as unknown as AudioData);
      expect(onRelease).toHaveBeenCalledOnce();

      await controller.stop();
    });

    it("tracks encode output callback metrics and passes encoded chunk to options.onEncodedFrame", async () => {
      const onEncodedFrame = vi.fn();
      const controller = new CaptureController();
      const ref: { encoderOutput: ((chunk: EncodedAudioChunk) => void) | null } = {
        encoderOutput: null,
      };

      (globalThis as unknown as Record<string, unknown>).AudioEncoder = class extends (
        MockAudioEncoder
      ) {
        constructor(init: {
          output: (chunk: EncodedAudioChunk) => void;
          error: (error: DOMException) => void;
        }) {
          super(init);
          ref.encoderOutput = init.output;
        }
      };

      await controller.start({ onEncodedFrame });

      // Frame arrives
      const mockFrame = new MockAudioData({ timestamp: 2000 });
      mockAdapterCallbacks?.onFrame(mockFrame as unknown as AudioData);

      // Encoder outputs chunk with matching timestamp
      const fakeChunk = {
        timestamp: 2000,
        byteLength: 64,
      } as EncodedAudioChunk;

      ref.encoderOutput?.(fakeChunk);

      expect(onEncodedFrame).toHaveBeenCalledWith(fakeChunk);

      const stats = controller.encodedObjectStats();
      expect(stats.frames).toEqual({ exposed: true, value: 1 });
      expect(stats.meanBytes).toEqual({ exposed: true, value: 64 });

      await controller.stop();
    });
  });

  describe("Controller state, muting, and teardown resilience", () => {
    it("reports NotExposed object stats before any frame is encoded", () => {
      const controller = new CaptureController();
      const stats = controller.encodedObjectStats();
      expect(stats.frames.exposed).toBe(false);
      expect(stats.meanBytes.exposed).toBe(false);
    });

    it("toggles track muting state correctly", async () => {
      const controller = new CaptureController();
      expect(controller.isMuted).toBe(false);

      controller.setMuted(true);
      expect(controller.isMuted).toBe(true);

      const stream = await controller.start({ onEncodedFrame: () => {} });
      const track = stream.getAudioTracks()[0];

      // Mutex state should be applied to newly created stream track
      expect(track?.enabled).toBe(false);

      controller.setMuted(false);
      expect(controller.isMuted).toBe(false);
      expect(track?.enabled).toBe(true);

      await controller.stop();
    });

    it("handles errors gracefully during stop() teardown", async () => {
      mockAdapterStopImpl = async () => {
        throw new Error("Adapter stop error");
      };

      const controller = new CaptureController();
      await controller.start({ onEncodedFrame: () => {} });

      const internal = controller as unknown as {
        encoder: MockAudioEncoder;
      };
      vi.spyOn(internal.encoder, "flush").mockRejectedValue(new Error("Encoder flush error"));

      // stop() should not throw even when adapter.stop() or encoder.flush() fail
      await expect(controller.stop()).resolves.toBeUndefined();

      expect(controller.dtxEnabled().exposed).toBe(false);
      expect(controller.capturePath().exposed).toBe(false);
    });

    it.each(["closed", "unconfigured"] as const)(
      "skips flush when the encoder is already %s",
      async (state) => {
        const controller = new CaptureController();
        const stream = await controller.start({ onEncodedFrame: () => {} });
        const internal = controller as unknown as {
          encoder: MockAudioEncoder;
        };
        internal.encoder.state = state;
        const flushSpy = vi.spyOn(internal.encoder, "flush");
        const closeSpy = vi.spyOn(internal.encoder, "close");

        await expect(controller.stop()).resolves.toBeUndefined();

        expect(flushSpy).not.toHaveBeenCalled();
        if (state === "closed") {
          expect(closeSpy).not.toHaveBeenCalled();
        } else {
          expect(closeSpy).toHaveBeenCalledOnce();
        }
        const [track] = (stream as unknown as MockMediaStream).tracks;
        expect(track?.stop).toHaveBeenCalledOnce();
      },
    );

    it("prevents re-entrant execution during stop() when already draining", async () => {
      let adapterStopCalls = 0;
      let releaseAdapterStop: (() => void) | undefined;
      const adapterStopGate = new Promise<void>((resolve) => {
        releaseAdapterStop = resolve;
      });
      mockAdapterStopImpl = async () => {
        adapterStopCalls += 1;
        await adapterStopGate;
      };

      const controller = new CaptureController();
      await controller.start({ onEncodedFrame: () => {} });

      const stopPromise1 = controller.stop();
      const stopPromise2 = controller.stop();

      expect(adapterStopCalls).toBe(1);
      releaseAdapterStop?.();
      await expect(Promise.all([stopPromise1, stopPromise2])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(adapterStopCalls).toBe(1);
    });

    it("exposes latencyStats, speaking, and level getters", async () => {
      const controller = new CaptureController();
      expect(controller.speaking).toBe(false);
      expect(controller.level).toBe(0);

      const latencyStats = controller.latencyStats();
      expect(latencyStats.frameFillMs.exposed).toBe(false);
      expect(latencyStats.encodeCallbackMs.exposed).toBe(false);

      await controller.start({ onEncodedFrame: () => {} });
      expect(mockAdapterCallbacks).not.toBeNull();

      const mockFrame = new MockAudioData({ timestamp: 1000, duration: 20000 });
      mockAdapterCallbacks?.onFrame(mockFrame as unknown as AudioData);

      const updatedStats = controller.latencyStats();
      expect(updatedStats.frameFillMs.exposed).toBe(true);
      if (updatedStats.frameFillMs.exposed) {
        expect(updatedStats.frameFillMs.value).toBe(20);
      }

      await controller.stop();
    });
  });
});
