import { useState } from "react";
import { MAX_SIMULATED_PARTICIPANTS } from "../../shared/contracts";
import { configurePresenter, createRoom, joinRoom, normaliseCode, storeSession } from "../api";
import { generateRandomDisplayName } from "../displayName";
import { rememberRelayCredential } from "../session/RoomSession";

export interface UseEntryFormOptions {
  navigate: (path: string) => void;
  initialCode?: string;
  stopMicrophone: () => void;
}

export function useEntryForm({ navigate, initialCode = "", stopMicrophone }: UseEntryFormOptions) {
  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState(normaliseCode(initialCode));
  const [busy, setBusy] = useState(false);
  const [pendingMode, setPendingMode] = useState<"create" | "join" | "presenter" | null>(null);
  const [error, setError] = useState("");
  const [simulatedHumans, setSimulatedHumans] = useState(5);
  const [simulatedAis, setSimulatedAis] = useState(2);

  const updateSimulatedHumans = (value: number) => {
    setSimulatedHumans(clamp(value));
  };

  const updateSimulatedAis = (value: number) => {
    setSimulatedAis(clamp(value));
  };

  const enterRoom = async (mode: "create" | "join" | "presenter") => {
    let enteredName = displayName.trim();
    if (!enteredName) {
      enteredName = generateRandomDisplayName();
      setDisplayName(enteredName);
    }
    if (mode === "join" && roomCode.length !== 20) {
      setError("Enter the complete 20-character room code.");
      return;
    }
    setBusy(true);
    setPendingMode(mode);
    setError("");
    try {
      const result =
        mode === "join" ? await joinRoom(roomCode, enteredName) : await createRoom(enteredName);
      const session = storeSession({
        code: result.room.code,
        participantId: result.participant.id,
        rejoinToken: result.rejoinToken,
        displayName: enteredName,
      });
      // §8: the relay credential stays in memory. It is never stored and never
      // placed in a URL that could be shared.
      rememberRelayCredential(result.participant.id, result.relayCredential);

      if (mode === "presenter") {
        sessionStorage.setItem(`real-fabric:presenter:${result.room.code}`, "true");
        await configurePresenter(session, {
          simulatedHumans,
          simulatedAis,
          // FR4: no live pipeline exists, so scripted responses are the only
          // honest option, and they are labelled as scripted everywhere.
          scriptedResponses: true,
        });
      }
      stopMicrophone();
      navigate(`/room/${result.room.code}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The room could not be opened.");
    } finally {
      setBusy(false);
      setPendingMode(null);
    }
  };

  return {
    displayName,
    setDisplayName,
    roomCode,
    setRoomCode: (code: string) => setRoomCode(normaliseCode(code)),
    busy,
    pendingMode,
    error,
    simulatedHumans,
    setSimulatedHumans: updateSimulatedHumans,
    simulatedAis,
    setSimulatedAis: updateSimulatedAis,
    enterRoom,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SIMULATED_PARTICIPANTS, Math.max(0, Math.trunc(value)));
}
