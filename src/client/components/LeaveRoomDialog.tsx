import type { RefObject } from "react";

interface LeaveRoomDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  code: string;
  leaveError: string | null;
  leaving: boolean;
  onCancel: () => void;
  onConfirmLeave: () => void;
}

export function LeaveRoomDialog({
  dialogRef,
  code,
  leaveError,
  leaving,
  onCancel,
  onConfirmLeave,
}: LeaveRoomDialogProps) {
  return (
    <dialog
      ref={dialogRef}
      className="leave-dialog"
      aria-labelledby="leave-dialog-title"
      aria-describedby="leave-dialog-desc"
      onCancel={onCancel}
    >
      <h2 id="leave-dialog-title">Leave room {code}?</h2>
      <p id="leave-dialog-desc">
        You will stop sending and receiving audio. You can rejoin with the same invite link.
      </p>
      {leaveError ? (
        <p className="leave-dialog__error" role="alert">
          {leaveError}
        </p>
      ) : null}
      <div className="leave-dialog__actions">
        <button
          className="button button--compact"
          type="button"
          disabled={leaving}
          onClick={() => dialogRef.current?.close()}
        >
          Stay
        </button>
        <button
          className="button button--compact button--danger"
          type="button"
          disabled={leaving}
          onClick={onConfirmLeave}
        >
          {leaving ? "Leaving…" : "Leave room"}
        </button>
      </div>
    </dialog>
  );
}
