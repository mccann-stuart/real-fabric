export type AudioSessionDiagnostic = "not_exposed" | "inactive" | "active" | "interrupted";
export type WakeLockDiagnostic = "not_exposed" | "requesting" | "active" | "released" | "denied";

export interface ForegroundAudioLifecycleState {
  audioSession: AudioSessionDiagnostic;
  wakeLock: WakeLockDiagnostic;
  wakeLockReason: string;
}

interface AudioSessionLike extends EventTarget {
  type: string;
  state?: "inactive" | "active" | "interrupted";
}

interface WakeLockSentinelLike extends EventTarget {
  released?: boolean;
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface ForegroundAudioEnvironment {
  audioSession: AudioSessionLike | null;
  wakeLock: WakeLockLike | null;
}

export interface ForegroundAudioLifecycleCallbacks {
  onInterrupted?: (reason: string) => void;
  onChange?: (state: ForegroundAudioLifecycleState) => void;
}

/**
 * Foreground-only iPhone audio lifecycle. Audio Session is a routing hint and
 * Screen Wake Lock is an optional convenience; neither is treated as proof
 * that capture, playout or MOQT works.
 */
export class ForegroundAudioLifecycle {
  private wakeLock: WakeLockSentinelLike | null = null;
  private listeningToAudioSession = false;
  private state: ForegroundAudioLifecycleState = {
    audioSession: "not_exposed",
    wakeLock: "not_exposed",
    wakeLockReason: "Screen Wake Lock is not exposed by this browser.",
  };

  constructor(
    private readonly callbacks: ForegroundAudioLifecycleCallbacks = {},
    private readonly environment: ForegroundAudioEnvironment = browserEnvironment(),
  ) {}

  /**
   * Call directly from Start/Resume. The wake-lock request is issued before
   * the first await so Safari can associate it with the same user activation.
   */
  async activate(): Promise<void> {
    this.activateAudioSession();
    const wakeLockRequest = this.requestWakeLock();
    await wakeLockRequest;
  }

  snapshot(): ForegroundAudioLifecycleState {
    return { ...this.state };
  }

  async releaseWakeLock(reason = "Audio is no longer in the foreground."): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock && !lock.released) await lock.release().catch(() => undefined);
    if (this.environment.wakeLock) {
      this.update({ wakeLock: "released", wakeLockReason: reason });
    }
  }

  async dispose(): Promise<void> {
    await this.releaseWakeLock("The room session ended.");
    if (this.listeningToAudioSession) {
      this.environment.audioSession?.removeEventListener("statechange", this.onAudioSessionState);
      this.listeningToAudioSession = false;
    }
  }

  private activateAudioSession(): void {
    const session = this.environment.audioSession;
    if (!session) {
      this.update({ audioSession: "not_exposed" });
      return;
    }
    session.type = "play-and-record";
    if (!this.listeningToAudioSession) {
      session.addEventListener("statechange", this.onAudioSessionState);
      this.listeningToAudioSession = true;
    }
    this.update({ audioSession: session.state ?? "active" });
  }

  private readonly onAudioSessionState = () => {
    const state = this.environment.audioSession?.state ?? "active";
    this.update({ audioSession: state });
    if (state === "interrupted") {
      this.callbacks.onInterrupted?.(
        "Safari reported that the play-and-record audio session was interrupted.",
      );
    }
  };

  private async requestWakeLock(): Promise<void> {
    const wakeLock = this.environment.wakeLock;
    if (!wakeLock) {
      this.update({
        wakeLock: "not_exposed",
        wakeLockReason: "Screen Wake Lock is not exposed; foreground audio can still start.",
      });
      return;
    }
    this.update({
      wakeLock: "requesting",
      wakeLockReason: "Requesting a foreground screen wake lock.",
    });
    try {
      const sentinel = await wakeLock.request("screen");
      this.wakeLock = sentinel;
      sentinel.addEventListener("release", () => {
        if (this.wakeLock === sentinel) this.wakeLock = null;
        this.update({
          wakeLock: "released",
          wakeLockReason: "The browser released the optional screen wake lock.",
        });
      });
      this.update({
        wakeLock: "active",
        wakeLockReason: "Optional foreground screen wake lock active.",
      });
    } catch (error) {
      this.update({
        wakeLock: "denied",
        wakeLockReason: `The optional screen wake lock was not granted: ${error instanceof Error ? error.message : "no reason reported"}.`,
      });
    }
  }

  private update(change: Partial<ForegroundAudioLifecycleState>): void {
    this.state = { ...this.state, ...change };
    this.callbacks.onChange?.(this.snapshot());
  }
}

function browserEnvironment(): ForegroundAudioEnvironment {
  if (typeof navigator === "undefined") return { audioSession: null, wakeLock: null };
  const candidate = navigator as Navigator & {
    audioSession?: AudioSessionLike;
    wakeLock?: WakeLockLike;
  };
  return {
    audioSession: candidate.audioSession ?? null,
    wakeLock: candidate.wakeLock ?? null,
  };
}
