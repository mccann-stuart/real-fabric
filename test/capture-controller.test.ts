import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureController } from "../src/client/audio/CaptureController";
import type { CaptureCallbacks } from "../src/client/audio/UniversalAudioCaptureAdapter";

describe("CaptureController error paths & audio capture lifecycle", () => {
  let originalMediaDevices: PropertyDescriptor | undefined;
  let originalAudioEncoder: PropertyDescriptor | undefined;
  let originalMediaStreamTrackProcessor: PropertyDescriptor | undefined;
  let originalAudioData: PropertyDescriptor | undefined;

  let mockAdapterCallbacks: CaptureCallbacks | null = null;
  let mockEncoderInstance: MockAudioEncoder | null = null;

  class MockAudioEncoder {
    static isConfigSupported = vi.fn().mockResolvedValue({
      supported: true,
      config: {
        codec: "opus",
        sampleRate: 48_000,
        numberOfChannels: 1,
        bitrate: 32_000,
        opus: {
          usedtx: true,
          application: "voip",
          signal: "voice",
          frameDuration: 20_000,
        },
      },
    });

    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    output: (chunk: EncodedAudioChunk) => void;
    error: (error: DOMException | Error) => void;

    constructor(init: {
      output: (chunk: EncodedAudioChunk) => void;
      error: (error: DOMException | Error) => void;
    }) {
      this.output = init.output;
      this.error = init.error;
      mockEncoderInstance = this;
    }

    configure = vi.fn(() => {
      this.state = "configured";
    });

    encode = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
    close = vi.fn(() => {
      this.state = "closed";
    });
  }

  function createMockStream(): MediaStream {
    const track = {
      kind: "audio",
      stop: vi.fn(),
      enabled: true,
    };
    return {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
  }

  beforeEach(() => {
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    originalAudioEncoder = Object.getOwnPropertyDescriptor(globalThis, "AudioEncoder");
    originalMediaStreamTrackProcessor = Object.getOwnPropertyDescriptor(
      globalThis,
      "MediaStreamTrackProcessor",
    );
    originalAudioData = Object.getOwnPropertyDescriptor(globalThis, "AudioData");

    mockAdapterCallbacks = null;
    mockEncoderInstance = null;

    const mockStream = createMockStream();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      },
    });

    Object.defineProperty(globalThis, "AudioEncoder", {
      configurable: true,
      value: MockAudioEncoder,
    });

    Object.defineProperty(globalThis, "AudioData", {
      configurable: true,
      value: class MockAudioData {},
    });

    Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
      configurable: true,
      value: class MockMediaStreamTrackProcessor {
        readable = {
          getReader: () => ({
            read: vi.fn().mockResolvedValue({ done: true }),
            cancel: vi.fn().mockResolvedValue(undefined),
          }),
        };
      },
    });
  });

  afterEach(() => {
    if (originalMediaDevices)
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    else Reflect.deleteProperty(navigator, "mediaDevices");

    if (originalAudioEncoder)
      Object.defineProperty(globalThis, "AudioEncoder", originalAudioEncoder);
    else Reflect.deleteProperty(globalThis, "AudioEncoder");

    if (originalMediaStreamTrackProcessor)
      Object.defineProperty(
        globalThis,
        "MediaStreamTrackProcessor",
        originalMediaStreamTrackProcessor,
      );
    else Reflect.deleteProperty(globalThis, "MediaStreamTrackProcessor");

    if (originalAudioData) Object.defineProperty(globalThis, "AudioData", originalAudioData);
    else Reflect.deleteProperty(globalThis, "AudioData");
  });

  function createMockAudioData(timestamp = 0, duration = 20): AudioData {
    return {
      timestamp,
      duration,
      numberOfFrames: 960,
      numberOfChannels: 1,
      copyTo: vi.fn(),
      close: vi.fn(),
    } as unknown as AudioData;
  }

  it("catches encoder.encode Error and forwards to options.onError", async () => {
    const onError = vi.fn();
    const controller = new CaptureController();

    // Intercept adapter.start to capture callbacks
    const adapterSpy = vi
      .spyOn(
        await import("../src/client/audio/UniversalAudioCaptureAdapter"),
        "createAudioCaptureAdapter",
      )
      .mockReturnValue({
        path: "track_processor",
        start: async (_stream, callbacks) => {
          mockAdapterCallbacks = callbacks;
        },
        stop: async () => undefined,
      });

    await controller.start({
      onEncodedFrame: () => undefined,
      onError,
    });

    expect(mockAdapterCallbacks).not.toBeNull();

    // Mock encoder.encode throwing an Error
    if (mockEncoderInstance) {
      mockEncoderInstance.encode.mockImplementation(() => {
        throw new Error("Encode hardware error");
      });
    }

    const testFrame = createMockAudioData(1000);
    mockAdapterCallbacks?.onFrame(testFrame);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0] as [Error])[0].message).toBe("Encode hardware error");

    adapterSpy.mockRestore();
    await controller.stop();
  });

  it("catches non-Error thrown during framing/encoding and wraps in generic Error", async () => {
    const onError = vi.fn();
    const controller = new CaptureController();

    const adapterSpy = vi
      .spyOn(
        await import("../src/client/audio/UniversalAudioCaptureAdapter"),
        "createAudioCaptureAdapter",
      )
      .mockReturnValue({
        path: "track_processor",
        start: async (_stream, callbacks) => {
          mockAdapterCallbacks = callbacks;
        },
        stop: async () => undefined,
      });

    await controller.start({
      onEncodedFrame: () => undefined,
      onError,
    });

    // Mock encoder.encode throwing a non-Error string
    if (mockEncoderInstance) {
      mockEncoderInstance.encode.mockImplementation(() => {
        throw "string error";
      });
    }

    const testFrame = createMockAudioData(1000);
    mockAdapterCallbacks?.onFrame(testFrame);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0] as [Error])[0].message).toBe("Capture encode failed.");

    adapterSpy.mockRestore();
    await controller.stop();
  });

  it("forwards AudioEncoder error callback to options.onError", async () => {
    const onError = vi.fn();
    const controller = new CaptureController();

    const adapterSpy = vi
      .spyOn(
        await import("../src/client/audio/UniversalAudioCaptureAdapter"),
        "createAudioCaptureAdapter",
      )
      .mockReturnValue({
        path: "track_processor",
        start: async (_stream, callbacks) => {
          mockAdapterCallbacks = callbacks;
        },
        stop: async () => undefined,
      });

    await controller.start({
      onEncodedFrame: () => undefined,
      onError,
    });

    expect(mockEncoderInstance).not.toBeNull();
    mockEncoderInstance?.error(new DOMException("Opus fatal error", "EncodingError"));

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0] as [Error])[0].message).toBe(
      "Opus encoder failed: EncodingError",
    );

    adapterSpy.mockRestore();
    await controller.stop();
  });

  it("forwards adapter onError callback to options.onError", async () => {
    const onError = vi.fn();
    const controller = new CaptureController();

    const adapterSpy = vi
      .spyOn(
        await import("../src/client/audio/UniversalAudioCaptureAdapter"),
        "createAudioCaptureAdapter",
      )
      .mockReturnValue({
        path: "track_processor",
        start: async (_stream, callbacks) => {
          mockAdapterCallbacks = callbacks;
        },
        stop: async () => undefined,
      });

    await controller.start({
      onEncodedFrame: () => undefined,
      onError,
    });

    const adapterError = new Error("Adapter hardware disconnect");
    mockAdapterCallbacks?.onError(adapterError);

    expect(onError).toHaveBeenCalledWith(adapterError);

    adapterSpy.mockRestore();
    await controller.stop();
  });

  it("tears down via stop() when adapter.start fails", async () => {
    const controller = new CaptureController();

    const adapterSpy = vi
      .spyOn(
        await import("../src/client/audio/UniversalAudioCaptureAdapter"),
        "createAudioCaptureAdapter",
      )
      .mockReturnValue({
        path: "track_processor",
        start: async () => {
          throw new Error("Adapter failed to start");
        },
        stop: async () => undefined,
      });

    await expect(
      controller.start({
        onEncodedFrame: () => undefined,
      }),
    ).rejects.toThrow("Adapter failed to start");

    // After failed start, capture state should be reset / stopped
    expect(controller.dtxEnabled().exposed).toBe(false);
    expect(controller.capturePath().exposed).toBe(false);

    adapterSpy.mockRestore();
  });

  it("evicts oldest pending timing when pending count exceeds MAXIMUM_PENDING_ENCODE_TIMINGS", async () => {
    const controller = new CaptureController();

    const adapterSpy = vi
      .spyOn(
        await import("../src/client/audio/UniversalAudioCaptureAdapter"),
        "createAudioCaptureAdapter",
      )
      .mockReturnValue({
        path: "track_processor",
        start: async (_stream, callbacks) => {
          mockAdapterCallbacks = callbacks;
        },
        stop: async () => undefined,
      });

    let onEncodedFrameCb: ((chunk: EncodedAudioChunk) => void) | undefined;
    await controller.start({
      onEncodedFrame: (chunk) => onEncodedFrameCb?.(chunk),
    });

    // Feed 257 frames without output callback
    for (let i = 0; i < 257; i++) {
      mockAdapterCallbacks?.onFrame(createMockAudioData(i * 1000));
    }

    // Output chunk corresponding to timestamp 0 (which was evicted)
    mockEncoderInstance?.output({
      timestamp: 0,
      byteLength: 50,
    } as EncodedAudioChunk);

    // Encode callback ms latency stats should not be observed for evicted timestamp 0
    const stats = controller.latencyStats();
    expect(stats.encodeCallbackMs.exposed).toBe(false);

    // Output chunk corresponding to timestamp 1 (which was retained)
    mockEncoderInstance?.output({
      timestamp: 1000,
      byteLength: 50,
    } as EncodedAudioChunk);

    expect(controller.latencyStats().encodeCallbackMs.exposed).toBe(true);

    adapterSpy.mockRestore();
    await controller.stop();
  });

  it("validates prerequisites for start() and exposes stats / lifecycle methods", async () => {
    const controller = new CaptureController();

    expect(controller.dtxEnabled().exposed).toBe(false);
    expect(controller.capturePath().exposed).toBe(false);
    expect(controller.encodedObjectStats().frames.exposed).toBe(false);
    expect(controller.isMuted).toBe(false);

    controller.setMuted(true);
    expect(controller.isMuted).toBe(true);

    const adapterSpy = vi
      .spyOn(
        await import("../src/client/audio/UniversalAudioCaptureAdapter"),
        "createAudioCaptureAdapter",
      )
      .mockReturnValue({
        path: "track_processor",
        start: async (_stream, callbacks) => {
          mockAdapterCallbacks = callbacks;
        },
        stop: async () => undefined,
      });

    let lastChunk: EncodedAudioChunk | null = null;
    await controller.start({
      onEncodedFrame: (chunk) => {
        lastChunk = chunk;
      },
    });

    expect(controller.dtxEnabled()).toEqual({ exposed: true, value: true });
    expect(controller.capturePath()).toEqual({ exposed: true, value: "track_processor" });

    // Try starting second time -> throws active error
    await expect(
      controller.start({
        onEncodedFrame: () => undefined,
      }),
    ).rejects.toThrow("Microphone capture is already active");

    // Feed a frame
    const frame = createMockAudioData(1000, 20);
    mockAdapterCallbacks?.onFrame(frame);

    // Output a chunk
    mockEncoderInstance?.output({
      timestamp: 1000,
      byteLength: 64,
    } as EncodedAudioChunk);

    expect(lastChunk).not.toBeNull();
    expect(controller.encodedObjectStats()).toMatchObject({
      frames: { exposed: true, value: 1 },
      meanBytes: { exposed: true, value: 64 },
    });

    expect(controller.latencyStats().frameFillMs.exposed).toBe(true);
    expect(controller.latencyStats().encodeCallbackMs.exposed).toBe(true);

    await controller.stop();
    expect(controller.dtxEnabled().exposed).toBe(false);
    expect(controller.capturePath().exposed).toBe(false);

    adapterSpy.mockRestore();
  });
});
