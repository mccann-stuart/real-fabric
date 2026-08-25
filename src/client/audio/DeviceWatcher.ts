import { type Measurement, measured, notExposed } from "../../shared/measurement";

/**
 * §11.3 deliverable two: hot-plugged microphones and headsets are detected
 * rather than requiring a reload.
 *
 * The demo's failure case is specific — someone joins with no input device, is
 * put into listen-only mode, then plugs in a headset and expects to speak. This
 * watches for exactly that transition and tells the session to offer
 * calibration.
 *
 * AC-14: device labels are never read, stored, logged or exported. Only the
 * count of audio inputs leaves this module, which is all the transition needs.
 */

export interface DeviceSnapshot {
  /** Number of audio input devices. Never their labels. */
  inputCount: number;
  at: number;
}

export type DeviceTransition = "first_input_appeared" | "input_added" | "input_removed" | "none";

export interface DeviceWatcherCallbacks {
  onChange?: (transition: DeviceTransition, snapshot: DeviceSnapshot) => void;
}

/**
 * The slice of `navigator.mediaDevices` this needs. Narrowed to an interface so
 * the transition logic is exercised without a browser, and so nothing here can
 * reach for a device label it has no business reading.
 */
export interface MediaDeviceSource {
  enumerateDevices(): Promise<Array<{ kind: string }>>;
  addEventListener(type: "devicechange", listener: () => void): void;
  removeEventListener(type: "devicechange", listener: () => void): void;
}

export class DeviceWatcher {
  private snapshot: DeviceSnapshot | null = null;
  private listener: (() => void) | null = null;
  private changes = 0;

  constructor(
    private readonly callbacks: DeviceWatcherCallbacks = {},
    private readonly source: MediaDeviceSource | null = defaultSource(),
  ) {}

  /** Idempotent. Safe to call when the browser exposes no device enumeration. */
  async start(): Promise<void> {
    if (this.listener) return;
    const devices = this.source;
    if (!devices) return;

    await this.refresh();
    const listener = () => void this.refresh();
    devices.addEventListener("devicechange", listener);
    this.listener = () => devices.removeEventListener("devicechange", listener);
  }

  stop(): void {
    this.listener?.();
    this.listener = null;
    this.snapshot = null;
  }

  /** H15: unknown until enumeration has actually run. */
  inputCount(): Measurement<number> {
    if (!this.snapshot) {
      return notExposed("This browser has not enumerated audio input devices.");
    }
    return measured(this.snapshot.inputCount);
  }

  deviceChanges(): Measurement<number> {
    if (!this.snapshot) {
      return notExposed("This browser has not enumerated audio input devices.");
    }
    return measured(this.changes);
  }

  private async refresh(): Promise<void> {
    if (!this.source) return;
    let inputCount: number;
    try {
      const devices = await this.source.enumerateDevices();
      inputCount = devices.filter((device) => device.kind === "audioinput").length;
    } catch {
      // An enumeration that fails is not a device change; leave the last known
      // count in place rather than reporting a spurious removal.
      return;
    }

    const previous = this.snapshot;
    const next: DeviceSnapshot = { inputCount, at: Date.now() };
    this.snapshot = next;
    if (!previous) return;
    if (previous.inputCount === inputCount) return;

    this.changes += 1;
    this.callbacks.onChange?.(classify(previous.inputCount, inputCount), next);
  }
}

function defaultSource(): MediaDeviceSource | null {
  // Typed as always present by the DOM lib, but absent in a worker, in an
  // insecure context and in the test runtime, so it is checked at runtime.
  const devices = globalThis.navigator?.mediaDevices as MediaDeviceSource | undefined;
  return typeof devices?.enumerateDevices === "function" ? devices : null;
}

function classify(previous: number, next: number): DeviceTransition {
  if (previous === 0 && next > 0) return "first_input_appeared";
  if (next > previous) return "input_added";
  if (next < previous) return "input_removed";
  return "none";
}
