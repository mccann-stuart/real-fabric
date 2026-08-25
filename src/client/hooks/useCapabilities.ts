import { useCallback, useEffect, useRef, useState } from "react";
import type { FailureCode } from "../../shared/failures";
import { fetchHealth } from "../api";

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
  /** H14: the specific §10 row, so the caller renders named copy not a generic error. */
  failure: FailureCode | null;
}

const INITIAL: CapabilityReport = {
  secureContext: "checking",
  webTransport: "checking",
  opus: "checking",
  microphone: "not_tested",
  relay: "checking",
  relayReason: "Checking the room service and draft gate.",
  failure: null,
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
      const secureContext: CheckState = globalThis.isSecureContext ? "ready" : "unavailable";
      const webTransport: CheckState = "WebTransport" in globalThis ? "ready" : "unavailable";
      let relay: CheckState = "unavailable";
      let relayReason = "The room service is unreachable.";
      let failure: FailureCode | null = null;

      try {
        const health = await fetchHealth();
        relay = health.transportVerified ? "ready" : "unavailable";
        relayReason = health.transportVerified
          ? `MOQT draft ${health.draft} trace verified. Inbound routing is ${health.routingEnforcement}; discovery is ${health.discovery}.`
          : `Room service ready; MOQT draft ${health.draft} has not passed a browser-to-relay trace.`;
        // H14: name the §10 row rather than collapsing everything into "error".
        if (!health.transportVerified) failure = "draft_endpoint_missing";
      } catch {
        relayReason = "The room service or relay probe could not be reached.";
        failure = "udp_blocked";
      }

      // A missing local capability outranks the relay: it is the nearer cause,
      // and its recovery advice is different.
      if (
        secureContext === "unavailable" ||
        webTransport === "unavailable" ||
        opus === "unavailable"
      ) {
        failure = "transport_unsupported";
      }

      if (active) {
        setReport((current) => ({
          ...current,
          secureContext,
          webTransport,
          opus,
          relay,
          relayReason,
          failure,
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
      const noDevice = name === "NotFoundError" || name === "DevicesNotFoundError";
      setReport((current) => ({
        ...current,
        microphone: noDevice ? "no_device" : "denied",
        failure: noDevice ? "microphone_no_device" : "microphone_denied",
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
