import type { FailureCode } from "../../shared/failures";
import type { CaptureMode, SessionPhase } from "../session/RoomSession";

export interface MicrophoneAction {
  disabled: boolean;
  label: string;
  visible: boolean;
}

/**
 * The header owns the single microphone action. Deriving it from the explicit
 * capture state prevents a listen-only retry and a generic start action from
 * appearing at the same time.
 */
export function microphoneAction(
  capture: CaptureMode | undefined,
  publishing: boolean,
  phase?: SessionPhase,
): MicrophoneAction {
  if (publishing || capture?.name === "publishing") {
    return { disabled: false, label: "Start microphone", visible: false };
  }
  if (
    phase?.name === "terminal" ||
    phase?.name === "left" ||
    (phase?.name === "blocked" && phase.failure !== "relay_request_refused")
  ) {
    return { disabled: false, label: "Start microphone", visible: false };
  }

  if (phase?.name === "resume_required" || capture?.name === "resume_required") {
    return { disabled: false, label: "Resume audio", visible: true };
  }
  if (phase?.name === "awaiting_audio_start") {
    return { disabled: false, label: "Start audio", visible: true };
  }

  switch (capture?.name) {
    case "starting":
      return { disabled: true, label: "Starting audio…", visible: true };
    case "opening_publication":
      return { disabled: true, label: "Opening publication…", visible: true };
    case "listen_only":
      return { disabled: false, label: "Try microphone again", visible: true };
    case "listen_only_device_available":
      return { disabled: false, label: "Start microphone", visible: true };
    default:
      return { disabled: false, label: "Start microphone", visible: true };
  }
}

/** Failures already explained by the status rail must not be rendered twice. */
export function representedFailureCodes(
  capture: CaptureMode | undefined,
  hasCapacityAnnouncement: boolean,
): FailureCode[] {
  const represented: FailureCode[] = [];
  if (capture?.name === "listen_only") represented.push(capture.failure);
  if (hasCapacityAnnouncement) represented.push("beyond_measured_capacity");
  return represented;
}

export function punctuateReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "No technical reason was reported.";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
