import { useCallback, useEffect, useRef, useState } from "react";

export type CheckState =
  | "checking"
  | "ready"
  | "unavailable"
  | "denied"
  | "no_device"
  | "not_tested";

export interface CapabilityReport {
  secureContext: CheckState;
  webTransport: CheckState;
  opus: CheckState;
  microphone: CheckState;
  relay: CheckState;
  relayReason: string;
}

const INITIAL: CapabilityReport = {
  secureContext: "checking",
  webTransport: "checking",
  opus: "checking",
  microphone: "not_tested",
  relay: "checking",
  relayReason: "Checking the room service and draft gate.",
};

export function useCapabilities() {
  const [report, setReport] = useState<CapabilityReport>(INITIAL);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const run = async () => {
      const opus = await checkOpus();
      let relay: CheckState = "unavailable";
      let relayReason = "The room service is unreachable.";
      try {
        const response = await fetch("/api/health", {
          headers: { "x-correlation-id": crypto.randomUUID() },
        });
        const health = (await response.json()) as { transportVerified?: boolean; draft?: string };
        relay = health.transportVerified ? "ready" : "unavailable";
        relayReason = health.transportVerified
          ? `MOQT draft ${health.draft ?? "Not exposed"} trace verified.`
          : `Room service ready; MOQT draft ${health.draft ?? "20"} relay trace unavailable.`;
      } catch {
        relayReason = "Room service or relay probe could not be reached.";
      }
      if (active) {
        setReport((current) => ({
          ...current,
          secureContext: globalThis.isSecureContext ? "ready" : "unavailable",
          webTransport: "WebTransport" in globalThis ? "ready" : "unavailable",
          opus,
          relay,
          relayReason,
        }));
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, []);

  const stopMicrophone = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => stopMicrophone, [stopMicrophone]);

  const testMicrophone = useCallback(async () => {
    stopMicrophone();
    if (!navigator.mediaDevices?.getUserMedia) {
      setReport((current) => ({ ...current, microphone: "no_device" }));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      streamRef.current = stream;
      const context = new AudioContext();
      audioContextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        const peak = samples.reduce(
          (maximum, value) => Math.max(maximum, Math.abs(value - 128)),
          0,
        );
        setLevel(Math.min(1, peak / 48));
        animationRef.current = requestAnimationFrame(tick);
      };
      tick();
      setReport((current) => ({ ...current, microphone: "ready" }));
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setReport((current) => ({
        ...current,
        microphone:
          name === "NotFoundError" || name === "DevicesNotFoundError" ? "no_device" : "denied",
      }));
    }
  }, [stopMicrophone]);

  return { report, level, testMicrophone, stopMicrophone };
}

async function checkOpus(): Promise<CheckState> {
  if (!("AudioEncoder" in globalThis)) return "unavailable";
  try {
    const result = await AudioEncoder.isConfigSupported({
      codec: "opus",
      sampleRate: 48_000,
      numberOfChannels: 1,
      bitrate: 32_000,
    });
    return result.supported ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}
