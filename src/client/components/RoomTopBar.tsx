import { Brand } from "./Brand";

interface RoomTopBarProps {
  code: string;
  copyState: "idle" | "copied" | "failed";
  onCopyInvite: () => void;
  micAction: {
    visible: boolean;
    disabled: boolean;
    label: string;
  };
  liveAudioEligible: boolean;
  publishing?: boolean | undefined;
  muted?: boolean | undefined;
  onToggleMute?: () => void;
  onStartAudio: () => void;
  onOpenLeaveDialog: () => void;
}

export function RoomTopBar({
  code,
  copyState,
  onCopyInvite,
  micAction,
  liveAudioEligible,
  publishing = false,
  muted = false,
  onToggleMute,
  onStartAudio,
  onOpenLeaveDialog,
}: RoomTopBarProps) {
  return (
    <>
      <header className="room-topbar">
        <Brand />
        <span title={`Room ${code}`}>
          Room <b>{code}</b>
        </span>
        {/* H4: stated in the room as well as before joining. */}
        <span className="headphones headphones--small">
          <span aria-hidden="true">⌁ </span>Headphones required
        </span>
        <button
          className={`button button--compact${copyState === "copied" ? " button--success" : ""}`}
          type="button"
          aria-label={
            copyState === "copied"
              ? "Invite link copied to clipboard"
              : copyState === "failed"
                ? "Retry copying invite link"
                : "Copy invite link to clipboard"
          }
          title={
            copyState === "copied"
              ? "Invite link copied to clipboard"
              : copyState === "failed"
                ? "Retry copying invite link"
                : "Copy invite link to clipboard"
          }
          onClick={onCopyInvite}
        >
          {copyState === "copied"
            ? "Invite copied"
            : copyState === "failed"
              ? "Retry copy"
              : "Copy invite"}
        </button>
        {micAction.visible && liveAudioEligible ? (
          <button
            className="button button--compact button--primary"
            disabled={micAction.disabled}
            aria-busy={micAction.disabled}
            aria-label={micAction.disabled ? `${micAction.label} (please wait)` : micAction.label}
            title={micAction.disabled ? `${micAction.label} (please wait)` : micAction.label}
            type="button"
            onClick={onStartAudio}
          >
            {micAction.label}
          </button>
        ) : publishing && onToggleMute ? (
          <button
            className={`button button--compact${muted ? " button--danger" : ""}`}
            type="button"
            aria-pressed={muted}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            title={muted ? "Unmute microphone" : "Mute microphone"}
            onClick={onToggleMute}
          >
            {muted ? "Unmute" : "Mute"}
          </button>
        ) : null}
        <button
          className="button button--compact button--danger"
          type="button"
          aria-haspopup="dialog"
          aria-label={`Leave room ${code}`}
          title={`Leave room ${code}`}
          onClick={onOpenLeaveDialog}
        >
          Leave room
        </button>
      </header>

      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "copied"
          ? "Invite link copied to the clipboard."
          : copyState === "failed"
            ? "The invite link could not be copied."
            : ""}
      </span>
    </>
  );
}
