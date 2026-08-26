import { useCallback, useEffect, useRef, useState } from "react";
import type { FailureCode } from "../../shared/failures";
import { fetchHealth } from "../api";
import { probeOpusEncoderSupport } from "../audio/CaptureController";
import { inspectAudioWorkletCaptureSupport } from "../audio/UniversalAudioCaptureAdapter";
import { draftsFramedByClient } from "../transport/MoqTransportAdapter";
import { notRunProbe, type ProbeResult, probeRelayReachability } from "../transport/NetworkProbe";

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
  webTransportReliability: CheckState;
  opusEncoder: CheckState;
  opusDecoder: CheckState;
  capture: CheckState;
  captureReason: string;
  playout: CheckState;
  playoutReason: string;
  microphone: CheckState;
  audioSession: CheckState;
  wakeLock: CheckState;
  dtx: CheckState;
  lowLatencyCongestionControl: CheckState;
  codecReason: string;
  relay: CheckState;
  relayReason: string;
  /** §11.2: HTTP/3 and QUIC reachability, run in the background. */
  network: ProbeResult;
  /** H14: the specific §10 row, so the caller renders named copy not a generic error. */
  failure: FailureCode | null;
}

export interface EvaluatedCapabilities
  extends Pick<
    CapabilityReport,
    | "secureContext"
    | "webTransport"
    | "opusEncoder"
    | "opusDecoder"
    | "capture"
    | "captureReason"
    | "playout"
    | "playoutReason"
    | "audioSession"
    | "wakeLock"
    | "dtx"
    | "codecReason"
    | "relay"
    | "relayReason"
    | "failure"
  > {
  relayEndpoint: string | null;
}

const INITIAL: CapabilityReport = {
  secureContext: "checking",
  webTransport: "checking",
  webTransportReliability: "not_tested",
  opusEncoder: "checking",
  opusDecoder: "checking",
  capture: "checking",
  captureReason: "Checking browser microphone framing APIs.",
  playout: "checking",
  playoutReason: "Checking browser audio decoding and mixing APIs.",
  microphone: "not_tested",
  audioSession: "not_tested",
  wakeLock: "not_tested",
  dtx: "not_tested",
  lowLatencyCongestionControl: "not_tested",
  codecReason: "Checking the required Opus encoder and decoder configurations.",
  relay: "checking",
  relayReason: "Checking the room service and draft gate.",
  network: notRunProbe("The relay reachability probe has not started."),
  failure: null,
};

export async function evaluateCapabilities(
  fetchHealthImpl = fetchHealth,
): Promise<EvaluatedCapabilities> {
  const [encoder, opusDecoder] = await Promise.all([probeOpusEncoderSupport(), checkOpusDecoder()]);
  const secureContext: CheckState = globalThis.isSecureContext ? "ready" : "unavailable";
  const webTransport: CheckState = "WebTransport" in globalThis ? "ready" : "unavailable";
  const captureSupport = inspectAudioWorkletCaptureSupport();
  const capture: CheckState = captureSupport.available ? "ready" : "unavailable";
  const playoutSupport = inspectPlayoutSupport();
  const playout: CheckState = playoutSupport.available ? "ready" : "unavailable";
  const opusEncoder: CheckState = encoder.supported ? "ready" : "unavailable";
  const browserNavigator = globalThis.navigator;
  const audioSession: CheckState =
    browserNavigator && "audioSession" in browserNavigator ? "ready" : "not_tested";
  const wakeLock: CheckState =
    browserNavigator && "wakeLock" in browserNavigator ? "ready" : "not_tested";
  const dtx: CheckState = encoder.dtx.exposed
    ? encoder.dtx.value
      ? "ready"
      : "unavailable"
    : "not_tested";
  let relay: CheckState = "unavailable";
  let relayReason = "The room service is unreachable.";
  let failure: FailureCode | null = null;
  let relayEndpoint: string | null = null;

  try {
    const health = await fetchHealthImpl();
    relayEndpoint = health.relayEndpoint;
    const framed = draftsFramedByClient();
    const endpoint = health.relayEndpointName ?? "no configured endpoint";

    if (!health.relayEndpoint) {
      // H14: no endpoint is a different fact from an endpoint that fails.
      relay = "unavailable";
      relayReason = `No relay endpoint is configured for MOQT draft ${health.draft}.`;
      failure = "draft_endpoint_missing";
    } else if (!health.relayCredentialConfigured) {
      relay = "unavailable";
      relayReason = `No provisioned relay credential is configured for ${endpoint}.`;
      failure = "relay_auth_unavailable";
    } else if (!framed.includes(health.draft as (typeof framed)[number])) {
      relay = "unavailable";
      relayReason = `This build frames MOQT draft ${framed.join(", ") || "no draft"}, but the room service is pinned to draft ${health.draft}.`;
      failure = "draft_mismatch";
    } else {
      // Configured and frameable: a live session will be attempted. Gate 1
      // verification is reported separately, never implied by "ready".
      relay = "ready";
      relayReason = health.transportVerified
        ? `MOQT draft ${health.draft} on ${endpoint} passed a browser-to-relay trace. Inbound routing is ${health.routingEnforcement}; discovery is ${health.discovery}.`
        : `MOQT draft ${health.draft} on ${endpoint} is configured and will be attempted live. No Gate 1 trace has been recorded, so transport is not yet claimed as verified.`;
    }
  } catch {
    relayReason = "The room service or relay probe could not be reached.";
    failure = "udp_blocked";
  }

  // A missing local capability outranks the relay: it is the nearer cause,
  // and its recovery advice is different.
  if (
    secureContext === "unavailable" ||
    webTransport === "unavailable" ||
    opusEncoder === "unavailable" ||
    opusDecoder === "unavailable" ||
    capture === "unavailable" ||
    playout === "unavailable"
  ) {
    failure = "transport_unsupported";
  }

  return {
    secureContext,
    webTransport,
    opusEncoder,
    opusDecoder,
    capture,
    captureReason: captureSupport.reason,
    playout,
    playoutReason: playoutSupport.reason,
    audioSession,
    wakeLock,
    dtx,
    codecReason: `${encoder.reason} ${opusDecoder === "ready" ? "Opus decode is available." : "The required Opus decoder configuration is unavailable."}`,
    relay,
    relayReason,
    failure,
    relayEndpoint,
  };
}

export function useCapabilities() {
  const [report, setReport] = useState<CapabilityReport>(INITIAL);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const run = async () => {
      const evaluation = await evaluateCapabilities();
      if (!active) return;

      const { relayEndpoint, ...evaluatedReport } = evaluation;
      setReport((current) => ({
        ...current,
        ...evaluatedReport,
      }));

      // §11.2 deliverable three: the probe runs in the background and never
      // gates entry. Its result refines the failure only when nothing nearer
      // has already claimed it.
      setReport((current) => ({
        ...current,
        network: { ...current.network, state: "probing", detail: "Testing HTTP/3 and QUIC…" },
      }));
      const network = await probeRelayReachability({ relayEndpoint });
      if (!active) return;
      const transportCapabilities = classifyTransportCapabilities(network);
      setReport((current) => ({
        ...current,
        network,
        ...transportCapabilities,
        failure:
          network.state === "reliable_only"
            ? "transport_reliable_only"
            : network.state === "udp_blocked" && current.failure === null
              ? "udp_blocked"
              : current.failure,
      }));
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

export function classifyTransportCapabilities(
  network: ProbeResult,
): Pick<CapabilityReport, "webTransportReliability" | "lowLatencyCongestionControl"> {
  const probeCompleted = network.state !== "not_run" && network.state !== "probing";
  return {
    webTransportReliability:
      network.reliability === "supports-unreliable"
        ? "ready"
        : probeCompleted
          ? "unavailable"
          : "not_tested",
    // Low-latency congestion control is a preference, not an admission gate.
    // A reported default/throughput result stays visible as unavailable without
    // changing the required reliability or failure result.
    lowLatencyCongestionControl:
      network.congestionControl === "low-latency"
        ? "ready"
        : network.congestionControl === "Not exposed"
          ? "not_tested"
          : "unavailable",
  };
}

export async function checkOpusDecoder(): Promise<CheckState> {
  if (!("AudioDecoder" in globalThis)) return "unavailable";
  try {
    const result = await AudioDecoder.isConfigSupported({
      codec: "opus",
      sampleRate: 48_000,
      numberOfChannels: 1,
    });
    return result.supported ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function inspectPlayoutSupport(): { available: boolean; reason: string } {
  const missing: string[] = [];
  if (!("AudioContext" in globalThis)) missing.push("AudioContext");
  if (!("AudioWorkletNode" in globalThis)) missing.push("AudioWorkletNode");
  if (!("AudioDecoder" in globalThis)) missing.push("WebCodecs AudioDecoder");
  return missing.length === 0
    ? { available: true, reason: "AudioWorklet playout and Opus decoding are exposed." }
    : {
        available: false,
        reason: `Playback is missing ${missing.join(", ")}.`,
      };
}
