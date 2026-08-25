export interface TelemetryEvent {
  at: number;
  type: string;
  participantId?: string;
  trackId?: string;
  value?: number | string;
}

export class SessionTelemetry {
  readonly correlationId = crypto.randomUUID();
  private events: TelemetryEvent[] = [];

  record(event: Omit<TelemetryEvent, "at">): void {
    this.events.push({ ...event, at: Date.now() });
  }

  export(roomId: string): Blob {
    return new Blob(
      [
        JSON.stringify(
          {
            format: "real-fabric-session-v1",
            correlationId: this.correlationId,
            roomId,
            exportedAt: Date.now(),
            excludes: ["audio", "transcripts", "credentials", "display names", "device labels"],
            events: this.events,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
  }
}
