import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CaptureController,
  type CaptureOptions,
  DEFAULT_BITRATE,
} from "../src/client/audio/CaptureController";

describe("CaptureController error handling and teardown", () => {
  let originalNavigator: PropertyDescriptor | undefined;
  let originalAudioEncoder: PropertyDescriptor | undefined;
  let originalAudioData: PropertyDescriptor | undefined;
  let originalProcessor: PropertyDescriptor | undefined;

  function createMockTrack() {
    return {
      kind: "audio",
      enabled: true,
      stop: vi.fn(),
    };
  }

  function createMockStream(tracks = [createMockTrack()]) {
    return {
      getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
      getTracks: () => tracks,
    };
  }

  beforeEach(() => {
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    originalAudioEncoder = Object.getOwnPropertyDescriptor(globalThis, "AudioEncoder");
    originalAudioData = Object.getOwnPropertyDescriptor(globalThis, "AudioData");
    originalProcessor = Object.getOwnPropertyDescriptor(globalThis, "MediaStreamTrackProcessor");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");

    if (originalAudioEncoder)
      Object.defineProperty(globalThis, "AudioEncoder", originalAudioEncoder);
    else Reflect.deleteProperty(globalThis, "AudioEncoder");

    if (originalAudioData) Object.defineProperty(globalThis, "AudioData", originalAudioData);
    else Reflect.deleteProperty(globalThis, "AudioData");

    if (originalProcessor)
      Object.defineProperty(globalThis, "MediaStreamTrackProcessor", originalProcessor);
    else Reflect.deleteProperty(globalThis, "MediaStreamTrackProcessor");
  });

  describe("stop() error paths", () => {
    it("swallows errors when adapter.stop() throws during teardown", async () => {
      const controller = new CaptureController();
      const mockTrack = createMockTrack();
      const mockStream = createMockStream([mockTrack]);

      const mockAdapter = {
        path: "track_processor" as const,
        start: vi.fn(),
        stop: vi.fn().mockRejectedValue(new Error("Adapter cancelled reader failure")),
      };

      const mockEncoder = {
        state: "configured",
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(function (this: { state: string }) {
          this.state = "closed";
        }),
      };

      (controller as unknown as { adapter: typeof mockAdapter }).adapter = mockAdapter;
      (controller as unknown as { encoder: typeof mockEncoder }).encoder = mockEncoder;
      (controller as unknown as { stream: typeof mockStream }).stream = mockStream;

      await expect(controller.stop()).resolves.toBeUndefined();

      expect(mockAdapter.stop).toHaveBeenCalledOnce();
      expect(mockEncoder.flush).toHaveBeenCalledOnce();
      expect(mockEncoder.close).toHaveBeenCalledOnce();
      expect(mockTrack.stop).toHaveBeenCalledOnce();
      expect(controller.capturePath().exposed).toBe(false);
      expect(controller.dtxEnabled().exposed).toBe(false);
    });

    it("swallows errors when encoder.flush() throws during teardown", async () => {
      const controller = new CaptureController();
      const mockTrack = createMockTrack();
      const mockStream = createMockStream([mockTrack]);

      const mockAdapter = {
        path: "track_processor" as const,
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const mockEncoder = {
        state: "configured",
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn().mockRejectedValue(new Error("Encoder flush error")),
        close: vi.fn(function (this: { state: string }) {
          this.state = "closed";
        }),
      };

      (controller as unknown as { adapter: typeof mockAdapter }).adapter = mockAdapter;
      (controller as unknown as { encoder: typeof mockEncoder }).encoder = mockEncoder;
      (controller as unknown as { stream: typeof mockStream }).stream = mockStream;

      await expect(controller.stop()).resolves.toBeUndefined();

      expect(mockAdapter.stop).toHaveBeenCalledOnce();
      expect(mockEncoder.flush).toHaveBeenCalledOnce();
      expect(mockEncoder.close).toHaveBeenCalledOnce();
      expect(mockTrack.stop).toHaveBeenCalledOnce();
      expect((controller as unknown as { encoder: unknown }).encoder).toBeNull();
      expect((controller as unknown as { stream: unknown }).stream).toBeNull();
    });

    it("swallows errors when both adapter.stop() and encoder.flush() throw during teardown", async () => {
      const controller = new CaptureController();
      const mockTrack = createMockTrack();
      const mockStream = createMockStream([mockTrack]);

      const mockAdapter = {
        path: "track_processor" as const,
        start: vi.fn(),
        stop: vi.fn().mockRejectedValue(new Error("Adapter stop error")),
      };

      const mockEncoder = {
        state: "configured",
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn().mockRejectedValue(new Error("Encoder flush error")),
        close: vi.fn(function (this: { state: string }) {
          this.state = "closed";
        }),
      };

      (controller as unknown as { adapter: typeof mockAdapter }).adapter = mockAdapter;
      (controller as unknown as { encoder: typeof mockEncoder }).encoder = mockEncoder;
      (controller as unknown as { stream: typeof mockStream }).stream = mockStream;

      await expect(controller.stop()).resolves.toBeUndefined();

      expect(mockAdapter.stop).toHaveBeenCalledOnce();
      expect(mockEncoder.flush).toHaveBeenCalledOnce();
      expect(mockEncoder.close).toHaveBeenCalledOnce();
      expect(mockTrack.stop).toHaveBeenCalledOnce();
      expect((controller as unknown as { encoder: unknown }).encoder).toBeNull();
      expect((controller as unknown as { stream: unknown }).stream).toBeNull();
    });

    it("prevents re-entrant teardown when stop() is called while draining", async () => {
      const controller = new CaptureController();

      let resolveAdapterStop!: () => void;
      const adapterStopPromise = new Promise<void>((resolve) => {
        resolveAdapterStop = resolve;
      });

      const mockAdapter = {
        path: "track_processor" as const,
        start: vi.fn(),
        stop: vi.fn().mockImplementation(() => adapterStopPromise),
      };

      (controller as unknown as { adapter: typeof mockAdapter }).adapter = mockAdapter;

      const firstStop = controller.stop();
      // Second concurrent stop call while draining is true
      const secondStop = controller.stop();

      expect(mockAdapter.stop).toHaveBeenCalledOnce();

      resolveAdapterStop();
      await Promise.all([firstStop, secondStop]);

      // adapter.stop was still only called once despite two stop() invocations
      expect(mockAdapter.stop).toHaveBeenCalledOnce();
    });

    it("handles stop() safely when encoder is already closed or unconfigured", async () => {
      const controller = new CaptureController();
      const mockTrack = createMockTrack();
      const mockStream = createMockStream([mockTrack]);

      const mockEncoder = {
        state: "closed",
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
      };

      (controller as unknown as { encoder: typeof mockEncoder }).encoder = mockEncoder;
      (controller as unknown as { stream: typeof mockStream }).stream = mockStream;

      await expect(controller.stop()).resolves.toBeUndefined();

      expect(mockEncoder.flush).not.toHaveBeenCalled();
      expect(mockEncoder.close).not.toHaveBeenCalled();
      expect(mockTrack.stop).toHaveBeenCalledOnce();
    });
  });

  describe("start() and error propagation", () => {
    function setupBrowserEnvironment(options?: {
      probeSupported?: boolean;
      adapterStartError?: Error;
    }) {
      const probeSupported = options?.probeSupported ?? true;
      const mockTrack = createMockTrack();
      const mockStream = createMockStream([mockTrack]);

      const getUserMedia = vi.fn().mockResolvedValue(mockStream);
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { mediaDevices: { getUserMedia } },
      });

      const required = {
        codec: "opus",
        sampleRate: 48_000,
        numberOfChannels: 1,
        bitrate: DEFAULT_BITRATE,
      };

      let encoderOutputCallback: ((chunk: EncodedAudioChunk) => void) | undefined;
      let encoderErrorCallback: ((error: DOMException) => void) | undefined;

      class FakeAudioEncoder {
        state = "unconfigured";
        configure = vi.fn(() => {
          this.state = "configured";
        });
        encode = vi.fn();
        flush = vi.fn().mockResolvedValue(undefined);
        close = vi.fn(() => {
          this.state = "closed";
        });

        constructor(init: {
          output: (chunk: EncodedAudioChunk) => void;
          error: (error: DOMException) => void;
        }) {
          encoderOutputCallback = init.output;
          encoderErrorCallback = init.error;
        }

        static isConfigSupported = vi.fn().mockResolvedValue({
          supported: probeSupported,
          config: required,
        });
      }

      Object.defineProperty(globalThis, "AudioEncoder", {
        configurable: true,
        value: FakeAudioEncoder,
      });

      Object.defineProperty(globalThis, "AudioData", {
        configurable: true,
        value: class FakeAudioData {},
      });

      const adapterStartError = options?.adapterStartError;
      if (adapterStartError) {
        Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
          configurable: true,
          value: class FailingMediaStreamTrackProcessor {
            constructor() {
              throw adapterStartError;
            }
          },
        });
      } else {
        Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
          configurable: true,
          value: class FakeMediaStreamTrackProcessor {
            readable = {
              getReader: () => ({
                read: vi.fn().mockResolvedValue({ done: true }),
                cancel: vi.fn().mockResolvedValue(undefined),
              }),
            };
          },
        });
      }

      return {
        mockStream,
        mockTrack,
        getEncoderCallbacks: () => ({
          output: encoderOutputCallback,
          error: encoderErrorCallback,
        }),
      };
    }

    it("triggers stop() and rethrows error if start() fails during probe", async () => {
      setupBrowserEnvironment({ probeSupported: false });
      const controller = new CaptureController();

      const options: CaptureOptions = {
        onEncodedFrame: vi.fn(),
      };

      await expect(controller.start(options)).rejects.toThrow();
      expect(controller.capturePath().exposed).toBe(false);
    });

    it("triggers stop() and rethrows error if adapter.start() fails", async () => {
      setupBrowserEnvironment({ adapterStartError: new Error("Adapter initialization error") });
      const controller = new CaptureController();

      const options: CaptureOptions = {
        onEncodedFrame: vi.fn(),
      };

      await expect(controller.start(options)).rejects.toThrow("Adapter initialization error");
      expect(controller.capturePath().exposed).toBe(false);
    });

    it("surfaces encoder error callback via options.onError", async () => {
      const { getEncoderCallbacks } = setupBrowserEnvironment();
      const controller = new CaptureController();
      const onError = vi.fn();

      await controller.start({
        onEncodedFrame: vi.fn(),
        onError,
      });

      const callbacks = getEncoderCallbacks();
      callbacks.error?.({ name: "EncodingError" } as DOMException);

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Opus encoder failed: EncodingError",
        }),
      );

      await controller.stop();
    });
  });
});
