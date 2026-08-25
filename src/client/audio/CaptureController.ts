export class CaptureController {
  private stream: MediaStream | null = null;
  private encoder: AudioEncoder | null = null;

  async start(onFrame: (frame: EncodedAudioChunk) => void): Promise<MediaStream> {
    if (this.stream || this.encoder)
      throw new Error("Microphone capture is already active for this participant.");
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Microphone capture is not exposed by this browser.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48_000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (!("AudioEncoder" in globalThis)) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
      throw new Error("WebCodecs AudioEncoder is not exposed by this browser.");
    }
    this.encoder = new AudioEncoder({
      output: onFrame,
      error: (error) =>
        console.error("Audio encoder failed", { name: error.name, message: error.message }),
    });
    this.encoder.configure({
      codec: "opus",
      sampleRate: 48_000,
      numberOfChannels: 1,
      bitrate: 32_000,
    });
    return this.stream;
  }

  async stop(): Promise<void> {
    try {
      if (this.encoder?.state === "configured") await this.encoder.flush();
    } finally {
      this.encoder?.close();
      this.encoder = null;
      for (const track of this.stream?.getTracks() ?? []) track.stop();
      this.stream = null;
    }
  }
}
