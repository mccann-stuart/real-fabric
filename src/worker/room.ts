import { DurableObject } from "cloudflare:workers";
import {
  MOQT_DRAFT,
  type Participant,
  REJOIN_WINDOW_MS,
  ROOM_LIFETIME_MS,
  type RoomEvent,
  type RoomSnapshot,
  type RoutingPreference,
} from "../shared/contracts";

interface ParticipantRow {
  [key: string]: SqlStorageValue;
  id: string;
  display_name: string;
  role: "human" | "ai";
  state: "connected" | "reconnecting" | "left";
  joined_at: number;
  reconnect_until: number | null;
  rejoin_hash: string;
}

interface RoutingRow {
  [key: string]: SqlStorageValue;
  human_id: string;
  ai_id: string;
  hears_me: number;
  i_hear_it: number;
  enforcement: "enforced" | "cooperative";
  updated_at: number;
}

interface MetaRow {
  [key: string]: SqlStorageValue;
  code: string;
  created_at: number;
  expires_at: number;
}

interface SocketAttachment {
  participantId: string;
}

export interface RoomJoinResult {
  room: RoomSnapshot;
  participant: Participant;
  rejoinToken: string;
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          code TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('human', 'ai')),
          state TEXT NOT NULL CHECK (state IN ('connected', 'reconnecting', 'left')),
          joined_at INTEGER NOT NULL,
          reconnect_until INTEGER,
          rejoin_hash TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS routing (
          human_id TEXT NOT NULL,
          ai_id TEXT NOT NULL,
          hears_me INTEGER NOT NULL DEFAULT 0,
          i_hear_it INTEGER NOT NULL DEFAULT 1,
          enforcement TEXT NOT NULL CHECK (enforcement IN ('enforced', 'cooperative')),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (human_id, ai_id)
        );
        CREATE TABLE IF NOT EXISTS rate_events (created_at INTEGER NOT NULL);
      `);
    });
  }

  checkCreationRateLimit(now: number): boolean {
    const cutoff = now - 10 * 60_000;
    this.ctx.storage.sql.exec("DELETE FROM rate_events WHERE created_at < ?", cutoff);
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM rate_events")
      .one();
    if (row.count >= 6) return false;
    this.ctx.storage.sql.exec("INSERT INTO rate_events (created_at) VALUES (?)", now);
    return true;
  }

  async initialise(code: string, now: number): Promise<RoomSnapshot> {
    const existing = this.meta();
    if (!existing) {
      const expiresAt = now + ROOM_LIFETIME_MS;
      this.ctx.storage.sql.exec(
        "INSERT INTO room_meta (singleton, code, created_at, expires_at) VALUES (1, ?, ?, ?)",
        code,
        now,
        expiresAt,
      );
      await this.ctx.storage.setAlarm(expiresAt);
    }
    return this.snapshot();
  }

  async join(displayName: string, rejoinToken?: string): Promise<RoomJoinResult> {
    this.assertActive();
    const now = Date.now();
    if (rejoinToken) {
      const rejoinHash = await sha256(rejoinToken);
      const existing = this.ctx.storage.sql
        .exec<ParticipantRow>(
          "SELECT * FROM participants WHERE rejoin_hash = ? AND reconnect_until >= ? LIMIT 1",
          rejoinHash,
          now,
        )
        .toArray()[0];
      if (existing) {
        this.ctx.storage.sql.exec(
          "UPDATE participants SET display_name = ?, state = 'connected', reconnect_until = NULL WHERE id = ?",
          displayName,
          existing.id,
        );
        const participant = this.participant(existing.id);
        this.broadcast({
          type: "participant_changed",
          participantId: existing.id,
          state: "connected",
          at: now,
        });
        return { room: this.snapshot(), participant, rejoinToken };
      }
    }

    const participantId = crypto.randomUUID();
    const token = randomToken();
    const hash = await sha256(token);
    this.ctx.storage.sql.exec(
      "INSERT INTO participants (id, display_name, role, state, joined_at, reconnect_until, rejoin_hash) VALUES (?, ?, 'human', 'connected', ?, NULL, ?)",
      participantId,
      displayName,
      now,
      hash,
    );
    const participant = this.participant(participantId);
    this.broadcast({ type: "participant_changed", participantId, state: "connected", at: now });
    return { room: this.snapshot(), participant, rejoinToken: token };
  }

  getSnapshot(): RoomSnapshot | null {
    const meta = this.meta();
    if (!meta || meta.expires_at <= Date.now()) return null;
    return this.snapshot();
  }

  async leave(participantId: string, rejoinToken: string): Promise<RoomSnapshot> {
    await this.assertParticipant(participantId, rejoinToken);
    const now = Date.now();
    const reconnectUntil = now + REJOIN_WINDOW_MS;
    this.ctx.storage.sql.exec(
      "UPDATE participants SET state = 'reconnecting', reconnect_until = ? WHERE id = ?",
      reconnectUntil,
      participantId,
    );
    await this.scheduleNextAlarm(reconnectUntil);
    this.broadcast({ type: "participant_changed", participantId, state: "reconnecting", at: now });
    return this.snapshot();
  }

  async updateRouting(
    participantId: string,
    rejoinToken: string,
    aiId: string,
    hearsMe: boolean,
    iHearIt: boolean,
  ): Promise<RoomSnapshot> {
    const human = await this.assertParticipant(participantId, rejoinToken);
    if (human.role !== "human") throw new Error("Only a human can own a routing preference.");
    const ai = this.ctx.storage.sql
      .exec<ParticipantRow>("SELECT * FROM participants WHERE id = ? AND role = 'ai'", aiId)
      .toArray()[0];
    if (!ai) throw new Error("The requested AI participant does not exist in this room.");
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO routing (human_id, ai_id, hears_me, i_hear_it, enforcement, updated_at)
       VALUES (?, ?, ?, ?, 'cooperative', ?)
       ON CONFLICT(human_id, ai_id) DO UPDATE SET
         hears_me = excluded.hears_me,
         i_hear_it = excluded.i_hear_it,
         updated_at = excluded.updated_at`,
      participantId,
      aiId,
      hearsMe ? 1 : 0,
      iHearIt ? 1 : 0,
      now,
    );
    this.broadcast({ type: "routing_changed", humanId: participantId, aiId, at: now });
    return this.snapshot();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    const url = new URL(request.url);
    const participantId = url.searchParams.get("participant") ?? "";
    const rejoinToken = url.searchParams.get("token") ?? "";
    if (!participantId || !rejoinToken) {
      return new Response("Participant control credentials are required.", { status: 401 });
    }
    try {
      await this.assertParticipant(participantId, rejoinToken);
    } catch {
      return new Response("Participant control credentials are invalid or expired.", {
        status: 401,
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ participantId } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server, [`participant:${participantId}`]);
    server.send(
      JSON.stringify({
        type: "snapshot",
        room: this.snapshot(),
        at: Date.now(),
      } satisfies RoomEvent),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const meta = this.meta();
    if (!meta) return;
    if (meta.expires_at <= now) {
      this.broadcast({ type: "room_expired", at: now });
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "room expired");
      this.ctx.storage.sql.exec("UPDATE participants SET state = 'left', reconnect_until = NULL");
      return;
    }

    this.ctx.storage.sql.exec(
      "UPDATE participants SET state = 'left', reconnect_until = NULL WHERE state = 'reconnecting' AND reconnect_until <= ?",
      now,
    );
    const nextReconnect = this.ctx.storage.sql
      .exec<{ reconnect_until: number }>(
        "SELECT reconnect_until FROM participants WHERE state = 'reconnecting' ORDER BY reconnect_until LIMIT 1",
      )
      .toArray()[0]?.reconnect_until;
    await this.ctx.storage.setAlarm(Math.min(meta.expires_at, nextReconnect ?? meta.expires_at));
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message !== "ping") {
      socket.close(1003, "control messages only");
      return;
    }
    socket.send("pong");
  }

  private meta(): MetaRow | undefined {
    return this.ctx.storage.sql
      .exec<MetaRow>("SELECT code, created_at, expires_at FROM room_meta LIMIT 1")
      .toArray()[0];
  }

  private assertActive(): MetaRow {
    const meta = this.meta();
    if (!meta) throw new Error("Room is not initialised.");
    if (meta.expires_at <= Date.now()) throw new Error("Room has expired.");
    return meta;
  }

  private participant(id: string): Participant {
    const row = this.ctx.storage.sql
      .exec<ParticipantRow>("SELECT * FROM participants WHERE id = ?", id)
      .one();
    return toParticipant(row);
  }

  private async assertParticipant(id: string, token: string): Promise<ParticipantRow> {
    this.assertActive();
    const hash = await sha256(token);
    const row = this.ctx.storage.sql
      .exec<ParticipantRow>(
        "SELECT * FROM participants WHERE id = ? AND rejoin_hash = ? AND state != 'left' LIMIT 1",
        id,
        hash,
      )
      .toArray()[0];
    if (!row) throw new Error("Participant credentials are invalid or expired.");
    return row;
  }

  private snapshot(): RoomSnapshot {
    const meta = this.assertActive();
    const participants = this.ctx.storage.sql
      .exec<ParticipantRow>("SELECT * FROM participants WHERE state != 'left' ORDER BY joined_at")
      .toArray()
      .map(toParticipant);
    const routing = this.ctx.storage.sql
      .exec<RoutingRow>("SELECT * FROM routing ORDER BY updated_at")
      .toArray()
      .map(toRouting);
    return {
      code: meta.code,
      createdAt: meta.created_at,
      expiresAt: meta.expires_at,
      participants,
      routing,
      transport: {
        availability: "draft_unavailable",
        draft: MOQT_DRAFT,
        endpoint: this.env.MOQ_RELAY_URL,
        reason: "MOQT draft 20 has not passed a browser-to-relay transport trace.",
      },
    };
  }

  private broadcast(event: RoomEvent): void {
    const encoded = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) socket.send(encoded);
  }

  private async scheduleNextAlarm(candidate: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || candidate < current) await this.ctx.storage.setAlarm(candidate);
  }
}

function toParticipant(row: ParticipantRow): Participant {
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    state: row.state,
    joinedAt: row.joined_at,
    reconnectUntil: row.reconnect_until,
  };
}

function toRouting(row: RoutingRow): RoutingPreference {
  return {
    humanId: row.human_id,
    aiId: row.ai_id,
    hearsMe: row.hears_me === 1,
    iHearIt: row.i_hear_it === 1,
    enforcement: row.enforcement,
    updatedAt: row.updated_at,
  };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
