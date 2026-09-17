import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureController } from "../src/client/audio/CaptureController";
import * as UniversalAudioCaptureAdapter from "../src/client/audio/UniversalAudioCaptureAdapter";

describe("CaptureController error handling and lifecycle", () => {
  let originalNavigator: PropertyDescriptor | undefined;
  let originalAudioEncoder: PropertyDescriptor | undefined;
  let captureAdapterCallbacks: UniversalAudioCaptureAdapter.CaptureCallbacks | null = null;
  let mockAdapterStart: ReturnType<
    typeof vi.fn<
      (
        stream: MediaStream,
        callbacks: UniversalAudioCaptureAdapter.CaptureCallbacks,
      ) => Promise<void>
    >
  >;
  let mockAdapterStop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let mockEncoderEncode: ReturnType<typeof vi.fn>;
  let mockEncoderConfigure: ReturnType<typeof vi.fn>;
  let mockEncoderClose: ReturnType<typeof vi.fn>;
  let encoderOutputCallback: ((chunk: unknown) => void) | null = null;
  let encoderErrorCallback: ((error: { name: string }) => void) | null = null;
  let mockMediaStreamTrackStop: ReturnType<typeof vi.fn>;
  let mockStream: MediaStream;

  beforeEach(() => {
    captureAdapterCallbacks = null;
    encoderOutputCallback = null;
    encoderErrorCallback = null;

    mockMediaStreamTrackStop = vi.fn();
    mockStream = {
      getAudioTracks: vi.fn().mockReturnValue([
        {
          enabled: true,
          stop: mockMediaStreamTrackStop,
        },
      ]),
      getTracks: vi.fn().mockReturnValue([
        {
          stop: mockMediaStreamTrackStop,
        },
      ]),
    } as unknown as MediaStream;

    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    originalAudioEncoder = Object.getOwnPropertyDescriptor(globalThis, "AudioEncoder");

    // Mock getUserMedia
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(mockStream),
        },
      },
      configurable: true,
      writable: true,
    });

    // Mock AudioEncoder
    mockEncoderEncode = vi.fn();
    mockEncoderConfigure = vi.fn();
    mockEncoderClose = vi.fn();

    function MockAudioEncoder(
      this: unknown,
      init: { output: (chunk: unknown) => void; error: (err: { name: string }) => void },
    ) {
      encoderOutputCallback = init.output;
      encoderErrorCallback = init.error;
      return {
        configure: mockEncoderConfigure,
        encode: mockEncoderEncode,
        close: mockEncoderClose,
        state: "configured",
      };
    }

    MockAudioEncoder.isConfigSupported = vi.fn().mockResolvedValue({
      supported: true,
      config: {
        codec: "opus",
        sampleRate: 48_000,
        numberOfChannels: 1,
        bitrate: 32_000,
        opus: { usedtx: true, frameDuration: 20_000, application: "voip", signal: "voice" },
      },
    });

    Object.defineProperty(globalThis, "AudioEncoder", {
      value: MockAudioEncoder,
      configurable: true,
      writable: true,
    });

    // Mock adapter
    mockAdapterStart = vi.fn(async (_stream, callbacks) => {
      captureAdapterCallbacks = callbacks;
    });
    mockAdapterStop = vi.fn(async () => undefined);

    vi.spyOn(UniversalAudioCaptureAdapter, "inspectCaptureSupport").mockReturnValue({
      available: true,
      path: "track_processor",
      reason: "Track processor support mock",
    });

    vi.spyOn(UniversalAudioCaptureAdapter, "createAudioCaptureAdapter").mockReturnValue({
      path: "track_processor",
      start: mockAdapterStart,
      stop: mockAdapterStop,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
    if (originalAudioEncoder) {
      Object.defineProperty(globalThis, "AudioEncoder", originalAudioEncoder);
    } else {
      Reflect.deleteProperty(globalThis, "AudioEncoder");
    }
  });

  it("handles error thrown by encoder.encode() and clears pendingEncodeStartedAt map entry", async () => {
    const controller = new CaptureController();
    const onError = vi.fn();

    await controller.start({
      onEncodedFrame: () => undefined,
      onError,
    });

    expect(captureAdapterCallbacks).not.toBeNull();

    const mockAudioData = {
      timestamp: 123456,
      duration: 20000,
      copyTo: vi.fn(),
    } as unknown as AudioData;

    const encodeError = new Error("Encoder hardware error");
    mockEncoderEncode.mockImplementationOnce(() => {
      throw encodeError;
    });

    // Send frame through onFrame
    captureAdapterCallbacks?.onFrame(mockAudioData);

    expect(mockEncoderEncode).toHaveBeenCalledWith(mockAudioData);
    expect(onError).toHaveBeenCalledWith(encodeError);

    // Verify pendingEncodeStartedAt map deleted timestamp 123456 by emitting an encoded chunk output for timestamp 123456
    // If pendingEncodeStartedAt entry wasn't deleted, output would record an encodeCallback metric from 123456.
    const latencyBefore = controller.latencyStats().encodeCallbackMs;
    expect(latencyBefore.exposed).toBe(false);

    if (encoderOutputCallback) {
      encoderOutputCallback({ timestamp: 123456, byteLength: 50 });
    }

    // Because the entry was cleaned up on exception, output callback won't observe latency timing for 123456
    const latencyAfter = controller.latencyStats().encodeCallbackMs;
    expect(latencyAfter.exposed).toBe(false);

    await controller.stop();
  });

  it("handles non-Error exception thrown during encoding and wraps it in an Error", async () => {
    const controller = new CaptureController();
    const onError = vi.fn();

    await controller.start({
      onEncodedFrame: () => undefined,
      onError,
    });

    const mockAudioData = {
      timestamp: 999999,
      duration: 20000,
      copyTo: vi.fn().mockImplementation(() => {
        throw "String exception in copyTo";
      }),
    } as unknown as AudioData;

    captureAdapterCallbacks?.onFrame(mockAudioData);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0] as [Error])[0].message).toBe("Capture encode failed.");

    await controller.stop();
  });

  it("relays AudioEncoder error callback to options.onError", async () => {
    const controller = new CaptureController();
    const onError = vi.fn();

    await controller.start({
      onEncodedFrame: () => undefined,
      onError,
    });

    expect(encoderErrorCallback).not.toBeNull();
    encoderErrorCallback?.({ name: "EncodingError" });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0] as [Error])[0].message).toBe(
      "Opus encoder failed: EncodingError",
    );

    await controller.stop();
  });

  it("relays adapter onError callback to options.onError", async () => {
    const controller = new CaptureController();
    const onError = vi.fn();

    await controller.start({
      onEncodedFrame: () => undefined,
      onError,
    });

    const adapterError = new Error("Microphone disconnected");
    captureAdapterCallbacks?.onError(adapterError);

    expect(onError).toHaveBeenCalledWith(adapterError);

    await controller.stop();
  });

  it("evicts the oldest timing from pendingEncodeStartedAt when limit is exceeded", async () => {
    const controller = new CaptureController();
    await controller.start({
      onEncodedFrame: () => undefined,
    });

    // Push 257 frames without output callbacks to exceed MAXIMUM_PENDING_ENCODE_TIMINGS (256)
    for (let i = 0; i < 257; i += 1) {
      const frame = {
        timestamp: 1000 + i,
        duration: 20000,
        copyTo: vi.fn(),
      } as unknown as AudioData;
      captureAdapterCallbacks?.onFrame(frame);
    }

    // The oldest timestamp (1000) should have been evicted.
    // Pushing output callback for timestamp 1000 should not record a metric.
    encoderOutputCallback?.({ timestamp: 1000, byteLength: 50 });
    expect(controller.latencyStats().encodeCallbackMs.exposed).toBe(false);

    // Output callback for timestamp 1001 (second pushed frame) should still be in the map and record a metric.
    encoderOutputCallback?.({ timestamp: 1001, byteLength: 50 });
    expect(controller.latencyStats().encodeCallbackMs.exposed).toBe(true);

    await controller.stop();
  });

  it("prevents starting capture twice", async () => {
    const controller = new CaptureController();
    await controller.start({ onEncodedFrame: () => undefined });

    await expect(controller.start({ onEncodedFrame: () => undefined })).rejects.toThrow(
      "Microphone capture is already active for this participant.",
    );

    await controller.stop();
  });

  it("throws if getUserMedia is not exposed", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });

    const controller = new CaptureController();
    await expect(controller.start({ onEncodedFrame: () => undefined })).rejects.toThrow(
      "Microphone capture is not exposed by this browser.",
    );
  });

  it("throws if AudioEncoder is not exposed", async () => {
    Reflect.deleteProperty(globalThis, "AudioEncoder");

    const controller = new CaptureController();
    await expect(controller.start({ onEncodedFrame: () => undefined })).rejects.toThrow(
      "WebCodecs AudioEncoder is not exposed by this browser.",
    );
  });

  it("throws if capture support is unavailable", async () => {
    vi.spyOn(UniversalAudioCaptureAdapter, "inspectCaptureSupport").mockReturnValue({
      available: false,
      path: null,
      reason: "No capture path supported",
    });

    const controller = new CaptureController();
    await expect(controller.start({ onEncodedFrame: () => undefined })).rejects.toThrow(
      "No capture path supported",
    );
  });

  it("cleans up resources via stop() when adapter start throws", async () => {
    mockAdapterStart.mockRejectedValueOnce(new Error("Adapter start failed"));

    const controller = new CaptureController();
    await expect(controller.start({ onEncodedFrame: () => undefined })).rejects.toThrow(
      "Adapter start failed",
    );

    expect(mockAdapterStop).toHaveBeenCalled();
    expect(mockMediaStreamTrackStop).toHaveBeenCalled();
    expect(controller.dtxEnabled().exposed).toBe(false);
  });
});
