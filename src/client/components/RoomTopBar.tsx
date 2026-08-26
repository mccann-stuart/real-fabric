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
  onStartAudio: () => void;
  onOpenLeaveDialog: () => void;
}

export function RoomTopBar({
  code,
  copyState,
  onCopyInvite,
  micAction,
  liveAudioEligible,
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
        <span className="headphones headphones--small">⌁ Headphones required</span>
        <button
          className={`button button--compact${copyState === "copied" ? " button--success" : ""}`}
          type="button"
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
            type="button"
            onClick={onStartAudio}
          >
            {micAction.label}
          </button>
        ) : null}
        <button
          className="button button--compact button--danger"
          type="button"
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
