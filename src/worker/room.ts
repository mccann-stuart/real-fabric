import { DurableObject } from "cloudflare:workers";
import {
  AI_TO_AI_TURN_CAP,
  type AiPipelineState,
  type AiToAiState,
  asMoqDraft,
  type DiscoveryMechanism,
  EMPTY_ROOM_EXPIRY_MS,
  evaluateComposition,
  type FloorState,
  MAX_SIMULATED_PARTICIPANTS,
  type MoqDraft,
  type Participant,
  PINNED_MOQT_DRAFT,
  type PresenterConfiguration,
  REJOIN_WINDOW_MS,
  ROOM_LIFETIME_MS,
  type RoomEvent,
  type RoomSnapshot,
  type RoutingEnforcement,
  type RoutingPreference,
  type TransportStatus,
} from "../shared/contracts";
import { configFlag, configValue } from "./env";
import { configuredRelayCredential } from "./relayCredential";
import { roomError } from "./roomError";

/** The relay's operator-facing name, as the inspector and Gate 1 sheet quote it. */
function endpointName(endpoint: string): string {
  if (!endpoint) return "no configured endpoint";
  try {
    return new URL(endpoint).host;
  } catch {
    return "an unparseable endpoint";
  }
}

/**
 * Bump when the table shape changes. Rooms are ephemeral and hard-stop at 20
 * minutes, so recreating an out-of-date schema loses nothing worth keeping and
 * is preferable to serving a snapshot with missing columns.
 */
const SCHEMA_VERSION = 2;
const CONTROL_AUTH_TIMEOUT_MS = 5_000;
const CONTROL_AUTH_MESSAGE_MAX_LENGTH = 512;

interface ParticipantRow {
  [key: string]: SqlStorageValue;
  id: string;
  display_name: string;
  role: "human" | "ai";
  state: "connected" | "reconnecting" | "left";
  joined_at: number;
  reconnect_until: number | null;
  rejoin_hash: string;
  simulated: number;
  address: string | null;
  wake_name: string | null;
  pipeline: AiPipelineState | null;
  last_active_at: number;
}

interface RoutingRow {
  [key: string]: SqlStorageValue;
  human_id: string;
  ai_id: string;
  hears_me: number;
  i_hear_it: number;
  updated_at: number;
}

interface MetaRow {
  [key: string]: SqlStorageValue;
  code: string;
  created_at: number;
  expires_at: number;
  empty_since: number | null;
  ai_to_ai_enabled: number;
  ai_to_ai_turns: number;
  ai_to_ai_capped_at: number | null;
  floor_holder: string | null;
  floor_since: number | null;
  simulated_humans: number;
  simulated_ais: number;
  scripted_responses: number;
}

interface SocketAttachment {
  participantId: string | null;
  authDeadline: number | null;
}

export interface RoomJoinResult {
  room: RoomSnapshot;
  participant: Participant;
  rejoinToken: string;
}

/**
 * Presenter and routing operations are authorised by the caller's own
 * participant credential, so the room service never acts on an unauthenticated
 * request to add an AI, move the floor or reshape the simulation.
 */
export interface ParticipantCredential {
  participantId: string;
  rejoinToken: string;
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
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
    if (!this.meta()) {
      this.ctx.storage.sql.exec(
        `INSERT INTO room_meta (
           singleton, code, created_at, expires_at, empty_since,
           ai_to_ai_enabled, ai_to_ai_turns, ai_to_ai_capped_at,
           floor_holder, floor_since,
           simulated_humans, simulated_ais, scripted_responses
         ) VALUES (1, ?, ?, ?, NULL, 0, 0, NULL, NULL, NULL, 0, 0, 0)`,
        code,
        now,
        now + ROOM_LIFETIME_MS,
      );
      await this.rescheduleAlarm();
    }
    return this.snapshot();
  }

  /**
   * H7: membership is open. This never refuses a join for capacity, count or
   * composition — degradation is the listener's problem to display, not the
   * room service's to prevent.
   */
  async join(displayName: string, rejoinToken?: string): Promise<RoomJoinResult> {
    this.assertActive();
    const now = Date.now();

    if (rejoinToken) {
      const reclaimed = await this.reclaim(displayName, rejoinToken, now);
      if (reclaimed) return reclaimed;
    }

    const participantId = crypto.randomUUID();
    const token = randomToken();
    this.ctx.storage.sql.exec(
      `INSERT INTO participants (
         id, display_name, role, state, joined_at, reconnect_until, rejoin_hash,
         simulated, address, wake_name, pipeline, last_active_at
       ) VALUES (?, ?, 'human', 'connected', ?, NULL, ?, 0, NULL, NULL, NULL, ?)`,
      participantId,
      displayName,
      now,
      await sha256(token),
      now,
    );
    // §8: a human joining later grants nothing until they act, so every row
    // starts with inbound consent withheld.
    this.seedRoutingForHuman(participantId, now);
    this.ctx.storage.sql.exec("UPDATE room_meta SET empty_since = NULL WHERE singleton = 1");
    await this.rescheduleAlarm();
    this.broadcast({ type: "participant_changed", participantId, state: "connected", at: now });
    return {
      room: this.snapshot(),
      participant: this.participant(participantId),
      rejoinToken: token,
    };
  }

  /**
   * H5: each AI arrives with its own address. H10 and §8 mean it starts
   * subscribed to nobody until each human consents individually.
   */
  async addAi(
    credential: ParticipantCredential,
    displayName: string,
    options: { address?: string; wakeName?: string; simulated?: boolean } = {},
  ): Promise<RoomSnapshot> {
    await this.assertHuman(credential);
    return this.addAiInternal(displayName, options);
  }

  private async addAiInternal(
    displayName: string,
    options: { address?: string; wakeName?: string; simulated?: boolean } = {},
  ): Promise<RoomSnapshot> {
    this.assertActive();
    const now = Date.now();
    const aiId = crypto.randomUUID();
    const address = options.address ?? `ai/${aiId.slice(0, 8)}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO participants (
         id, display_name, role, state, joined_at, reconnect_until, rejoin_hash,
         simulated, address, wake_name, pipeline, last_active_at
       ) VALUES (?, ?, 'ai', 'connected', ?, NULL, ?, ?, ?, ?, 'listening', ?)`,
      aiId,
      displayName,
      now,
      await sha256(randomToken()),
      options.simulated ? 1 : 0,
      address,
      options.wakeName ?? displayName,
      now,
    );
    // Adding an AI mid-session does not inherit consent from AIs already present.
    this.seedRoutingForAi(aiId, now);
    this.broadcast({
      type: "participant_changed",
      participantId: aiId,
      state: "connected",
      at: now,
    });
    return this.snapshot();
  }

  async removeAi(credential: ParticipantCredential, aiId: string): Promise<RoomSnapshot> {
    await this.assertHuman(credential);
    return this.removeAiInternal(aiId);
  }

  private async removeAiInternal(aiId: string): Promise<RoomSnapshot> {
    this.assertActive();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE participants SET state = 'left', pipeline = 'unavailable', reconnect_until = NULL WHERE id = ? AND role = 'ai'",
      aiId,
    );
    this.ctx.storage.sql.exec("DELETE FROM routing WHERE ai_id = ?", aiId);
    await this.releaseFloorInternal(aiId, now);
    this.broadcast({ type: "participant_changed", participantId: aiId, state: "left", at: now });
    return this.snapshot();
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
    await this.rescheduleAlarm();
    this.broadcast({ type: "participant_changed", participantId, state: "reconnecting", at: now });
    return this.snapshot();
  }

  /**
   * H9: the listener owns the row. Inbound is the AI's subscription to this
   * human; outbound is this human's subscription to the AI and affects nobody
   * else.
   */
  async updateRouting(
    participantId: string,
    rejoinToken: string,
    aiId: string,
    hearsMe: boolean,
    iHearIt: boolean,
  ): Promise<RoomSnapshot> {
    const human = await this.assertParticipant(participantId, rejoinToken);
    if (human.role !== "human") {
      throw roomError(403, "human_only", "Only a human can own a routing preference.");
    }
    const ai = this.ctx.storage.sql
      .exec<ParticipantRow>(
        "SELECT * FROM participants WHERE id = ? AND role = 'ai' AND state != 'left'",
        aiId,
      )
      .toArray()[0];
    if (!ai) {
      throw roomError(
        404,
        "ai_not_found",
        "The requested AI participant does not exist in this room.",
      );
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO routing (human_id, ai_id, hears_me, i_hear_it, updated_at)
       VALUES (?, ?, ?, ?, ?)
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

  async setAiPipeline(
    credential: ParticipantCredential,
    aiId: string,
    pipeline: AiPipelineState,
  ): Promise<RoomSnapshot> {
    await this.assertHuman(credential);
    this.assertActive();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE participants SET pipeline = ?, last_active_at = ? WHERE id = ? AND role = 'ai'",
      pipeline,
      pipeline === "speaking" ? now : (this.participantRow(aiId)?.last_active_at ?? now),
      aiId,
    );
    this.broadcast({ type: "ai_pipeline_changed", aiId, pipeline, at: now });
    return this.snapshot();
  }

  /**
   * FR4 floor control: an AI does not begin publishing while another AI is
   * publishing. A second addressed AI queues and shows Thinking.
   */
  async requestFloor(
    credential: ParticipantCredential,
    aiId: string,
  ): Promise<{ granted: boolean; room: RoomSnapshot }> {
    await this.assertHuman(credential);
    this.assertActive();
    const now = Date.now();
    const meta = this.meta();
    if (!meta) throw roomError(404, "room_not_found", "Room is not initialised.");

    if (meta.floor_holder === aiId) return { granted: true, room: this.snapshot() };
    if (meta.floor_holder === null) {
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET floor_holder = ?, floor_since = ? WHERE singleton = 1",
        aiId,
        now,
      );
      this.ctx.storage.sql.exec("DELETE FROM floor_queue WHERE ai_id = ?", aiId);
      this.broadcast({ type: "floor_changed", holderId: aiId, queue: this.floorQueue(), at: now });
      return { granted: true, room: this.snapshot() };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO floor_queue (ai_id, queued_at) VALUES (?, ?) ON CONFLICT(ai_id) DO NOTHING",
      aiId,
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE participants SET pipeline = 'thinking' WHERE id = ? AND role = 'ai'",
      aiId,
    );
    this.broadcast({
      type: "floor_changed",
      holderId: meta.floor_holder,
      queue: this.floorQueue(),
      at: now,
    });
    return { granted: false, room: this.snapshot() };
  }

  async releaseFloor(credential: ParticipantCredential, aiId: string): Promise<RoomSnapshot> {
    await this.assertHuman(credential);
    this.assertActive();
    await this.releaseFloorInternal(aiId, Date.now());
    return this.snapshot();
  }

  /** FR4: enabling AI-to-AI is a presenter action, and it is capped. */
  async setAiToAi(credential: ParticipantCredential, enabled: boolean): Promise<RoomSnapshot> {
    await this.assertHuman(credential);
    this.assertActive();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE room_meta SET ai_to_ai_enabled = ?, ai_to_ai_turns = 0, ai_to_ai_capped_at = NULL WHERE singleton = 1",
      enabled ? 1 : 0,
    );
    this.broadcast({ type: "ai_to_ai_changed", enabled, consecutiveTurns: 0, at: now });
    return this.snapshot();
  }

  /**
   * Returns false once the cap is reached. Two agents will talk until the room
   * is unusable, so the counter is the mechanism, not a warning.
   */
  async recordAiToAiTurn(
    credential: ParticipantCredential,
  ): Promise<{ allowed: boolean; room: RoomSnapshot }> {
    await this.assertHuman(credential);
    this.assertActive();
    const meta = this.meta();
    if (!meta) return { allowed: false, room: this.snapshot() };
    // Off by default (H10): a turn is only ever allowed after a presenter action.
    if (meta.ai_to_ai_enabled !== 1) return { allowed: false, room: this.snapshot() };
    const now = Date.now();
    if (meta.ai_to_ai_turns >= AI_TO_AI_TURN_CAP) {
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET ai_to_ai_capped_at = ? WHERE singleton = 1 AND ai_to_ai_capped_at IS NULL",
        now,
      );
      return { allowed: false, room: this.snapshot() };
    }
    const turns = meta.ai_to_ai_turns + 1;
    this.ctx.storage.sql.exec("UPDATE room_meta SET ai_to_ai_turns = ? WHERE singleton = 1", turns);
    this.broadcast({ type: "ai_to_ai_changed", enabled: true, consecutiveTurns: turns, at: now });
    return { allowed: true, room: this.snapshot() };
  }

  /** A human turn breaks the AI-to-AI chain, so the cap counts consecutive turns only. */
  async resetAiToAiTurns(credential: ParticipantCredential): Promise<void> {
    await this.assertHuman(credential);
    if (!this.meta()) return;
    this.ctx.storage.sql.exec(
      "UPDATE room_meta SET ai_to_ai_turns = 0, ai_to_ai_capped_at = NULL WHERE singleton = 1",
    );
  }

  /**
   * H11: presenter simulation is a configurable count of unmistakably labelled
   * participants, reconciled against whatever is already present.
   */
  async configurePresenter(
    credential: ParticipantCredential,
    configuration: PresenterConfiguration,
  ): Promise<RoomSnapshot> {
    await this.assertHuman(credential);
    this.assertActive();
    const humans = clampSimulated(configuration.simulatedHumans);
    const ais = clampSimulated(configuration.simulatedAis);
    this.ctx.storage.sql.exec(
      "UPDATE room_meta SET simulated_humans = ?, simulated_ais = ?, scripted_responses = ? WHERE singleton = 1",
      humans,
      ais,
      configuration.scriptedResponses ? 1 : 0,
    );
    await this.reconcileSimulated("human", humans);
    await this.reconcileSimulated("ai", ais);
    return this.snapshot();
  }

  /** Audio object arrival is the source of truth for "connected" (§6.2). */
  async markActive(credential: ParticipantCredential, participantId: string): Promise<void> {
    await this.assertParticipant(credential.participantId, credential.rejoinToken);
    // Security: Restrict activity updates to the caller's own participant ID to prevent activity spoofing (CWE-639).
    if (credential.participantId !== participantId) {
      throw roomError(
        403,
        "unauthorized_target",
        "Participants can only update their own activity state.",
      );
    }
    if (!this.meta()) return;
    this.ctx.storage.sql.exec(
      "UPDATE participants SET last_active_at = ? WHERE id = ?",
      Date.now(),
      participantId,
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    const meta = this.meta();
    if (!meta) return new Response("Room not found.", { status: 404 });
    if (meta.expires_at <= Date.now()) return new Response("Room expired.", { status: 410 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      participantId: null,
      authDeadline: Date.now() + CONTROL_AUTH_TIMEOUT_MS,
    } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    await this.rescheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (
        attachment &&
        !attachment.participantId &&
        attachment.authDeadline !== null &&
        attachment.authDeadline <= now
      ) {
        socket.close(4408, "control authentication timed out");
      }
    }
    const meta = this.meta();
    if (!meta) return;

    // FR1: the hard stop ends the room and its AI sessions outright.
    if (meta.expires_at <= now || this.emptyExpiryDue(meta, now)) {
      this.broadcast({ type: "room_expired", at: now });
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "room expired");
      this.ctx.storage.sql.exec(
        "UPDATE participants SET state = 'left', reconnect_until = NULL, pipeline = CASE WHEN role = 'ai' THEN 'unavailable' ELSE pipeline END",
      );
      this.ctx.storage.sql.exec("DELETE FROM floor_queue");
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET expires_at = ?, floor_holder = NULL, floor_since = NULL WHERE singleton = 1",
        Math.min(meta.expires_at, now),
      );
      return;
    }

    this.ctx.storage.sql.exec(
      "UPDATE participants SET state = 'left', reconnect_until = NULL WHERE state = 'reconnecting' AND reconnect_until <= ?",
      now,
    );
    this.noteEmptiness(now);
    await this.rescheduleAlarm();
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      socket.close(1003, "control messages only");
      return;
    }

    const attachment = socket.deserializeAttachment() as SocketAttachment | null;

    if (!attachment?.participantId) {
      if (message.length > CONTROL_AUTH_MESSAGE_MAX_LENGTH) {
        socket.close(1009, "authentication message too large");
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(message);
      } catch {
        socket.close(4401, "invalid authentication message");
        return;
      }

      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as Record<string, unknown>).type !== "auth"
      ) {
        socket.close(4401, "authentication required");
        return;
      }

      const participantId = (payload as Record<string, unknown>).participantId;
      const token = (payload as Record<string, unknown>).token;

      if (
        typeof participantId !== "string" ||
        participantId.length === 0 ||
        participantId.length > 64 ||
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > 128
      ) {
        socket.close(4401, "participant control credentials required");
        return;
      }

      try {
        await this.assertParticipant(participantId, token);
      } catch {
        socket.close(4401, "participant control credentials invalid or expired");
        return;
      }

      socket.serializeAttachment({
        participantId,
        authDeadline: null,
      } satisfies SocketAttachment);
      await this.rescheduleAlarm();

      socket.send(
        JSON.stringify({
          type: "snapshot",
          room: this.snapshot(),
          at: Date.now(),
        } satisfies RoomEvent),
      );
      return;
    }

    if (message !== "ping") {
      socket.close(1003, "control messages only");
      return;
    }
    socket.send("pong");
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
    const current =
      sql.exec<{ version: number }>("SELECT version FROM schema_meta LIMIT 1").toArray()[0]
        ?.version ?? 0;
    if (current === SCHEMA_VERSION) return;

    for (const table of ["participants", "routing", "room_meta", "floor_queue"]) {
      sql.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    sql.exec(`
      CREATE TABLE room_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        empty_since INTEGER,
        ai_to_ai_enabled INTEGER NOT NULL DEFAULT 0,
        ai_to_ai_turns INTEGER NOT NULL DEFAULT 0,
        ai_to_ai_capped_at INTEGER,
        floor_holder TEXT,
        floor_since INTEGER,
        simulated_humans INTEGER NOT NULL DEFAULT 0,
        simulated_ais INTEGER NOT NULL DEFAULT 0,
        scripted_responses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('human', 'ai')),
        state TEXT NOT NULL CHECK (state IN ('connected', 'reconnecting', 'left')),
        joined_at INTEGER NOT NULL,
        reconnect_until INTEGER,
        rejoin_hash TEXT NOT NULL UNIQUE,
        simulated INTEGER NOT NULL DEFAULT 0,
        address TEXT,
        wake_name TEXT,
        pipeline TEXT CHECK (
          pipeline IN ('listening', 'thinking', 'speaking', 'interrupted', 'unavailable')
        ),
        last_active_at INTEGER NOT NULL
      );
      CREATE TABLE routing (
        human_id TEXT NOT NULL,
        ai_id TEXT NOT NULL,
        hears_me INTEGER NOT NULL DEFAULT 0,
        i_hear_it INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (human_id, ai_id)
      );
      CREATE TABLE floor_queue (
        ai_id TEXT PRIMARY KEY,
        queued_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_events (created_at INTEGER NOT NULL);
    `);
    sql.exec("DELETE FROM schema_meta");
    sql.exec("INSERT INTO schema_meta (version) VALUES (?)", SCHEMA_VERSION);
  }

  private async reclaim(
    displayName: string,
    rejoinToken: string,
    now: number,
  ): Promise<RoomJoinResult | null> {
    const rejoinHash = await sha256(rejoinToken);
    const existing = this.ctx.storage.sql
      .exec<ParticipantRow>(
        `SELECT * FROM participants
         WHERE rejoin_hash = ? AND state != 'left' AND (reconnect_until IS NULL OR reconnect_until >= ?)
         LIMIT 1`,
        rejoinHash,
        now,
      )
      .toArray()[0];
    if (!existing) return null;

    // H12: same identity, same routing rows, no second participant created.
    this.ctx.storage.sql.exec(
      "UPDATE participants SET display_name = ?, state = 'connected', reconnect_until = NULL WHERE id = ?",
      displayName,
      existing.id,
    );
    this.ctx.storage.sql.exec("UPDATE room_meta SET empty_since = NULL WHERE singleton = 1");
    this.broadcast({
      type: "participant_changed",
      participantId: existing.id,
      state: "connected",
      at: now,
    });
    return {
      room: this.snapshot(),
      participant: this.participant(existing.id),
      rejoinToken,
    };
  }

  private seedRoutingForHuman(humanId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO routing (human_id, ai_id, hears_me, i_hear_it, updated_at)
       SELECT ?, id, 0, 1, ? FROM participants WHERE role = 'ai' AND state != 'left'
       ON CONFLICT(human_id, ai_id) DO NOTHING`,
      humanId,
      now,
    );
  }

  private seedRoutingForAi(aiId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO routing (human_id, ai_id, hears_me, i_hear_it, updated_at)
       SELECT id, ?, 0, 1, ? FROM participants WHERE role = 'human' AND state != 'left'
       ON CONFLICT(human_id, ai_id) DO NOTHING`,
      aiId,
      now,
    );
  }

  private async releaseFloorInternal(aiId: string, now: number): Promise<void> {
    const meta = this.meta();
    if (!meta) return;
    this.ctx.storage.sql.exec("DELETE FROM floor_queue WHERE ai_id = ?", aiId);
    if (meta.floor_holder !== aiId) {
      this.broadcast({
        type: "floor_changed",
        holderId: meta.floor_holder,
        queue: this.floorQueue(),
        at: now,
      });
      return;
    }
    const next = this.ctx.storage.sql
      .exec<{ ai_id: string }>("SELECT ai_id FROM floor_queue ORDER BY queued_at LIMIT 1")
      .toArray()[0];
    if (next) {
      this.ctx.storage.sql.exec("DELETE FROM floor_queue WHERE ai_id = ?", next.ai_id);
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET floor_holder = ?, floor_since = ? WHERE singleton = 1",
        next.ai_id,
        now,
      );
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET floor_holder = NULL, floor_since = NULL WHERE singleton = 1",
      );
    }
    this.broadcast({
      type: "floor_changed",
      holderId: next?.ai_id ?? null,
      queue: this.floorQueue(),
      at: now,
    });
  }

  private async reconcileSimulated(role: "human" | "ai", target: number): Promise<void> {
    const existing = this.ctx.storage.sql
      .exec<ParticipantRow>(
        "SELECT * FROM participants WHERE simulated = 1 AND role = ? AND state != 'left' ORDER BY joined_at",
        role,
      )
      .toArray();

    const countToAdd = target - existing.length;

    if (countToAdd > 0) {
      const now = Date.now();
      if (role === "human") {
        const added = await Promise.all(
          Array.from({ length: countToAdd }, (_, i) => {
            const index = existing.length + i;
            const name = simulatedName("human", index);
            const id = crypto.randomUUID();
            return sha256(randomToken()).then((hash) => ({ id, name, hash }));
          }),
        );

        const ais = this.ctx.storage.sql
          .exec<ParticipantRow>("SELECT id FROM participants WHERE role = 'ai' AND state != 'left'")
          .toArray();

        const CHUNK_SIZE = 10;
        for (let i = 0; i < added.length; i += CHUNK_SIZE) {
          const chunk = added.slice(i, i + CHUNK_SIZE);
          const valuePlaceholders: string[] = [];
          const params: SqlStorageValue[] = [];
          for (const item of chunk) {
            valuePlaceholders.push(
              "(?, ?, 'human', 'connected', ?, NULL, ?, 1, NULL, NULL, NULL, ?)",
            );
            params.push(item.id, item.name, now, item.hash, now);
          }
          this.ctx.storage.sql.exec(
            `INSERT INTO participants (
               id, display_name, role, state, joined_at, reconnect_until, rejoin_hash,
               simulated, address, wake_name, pipeline, last_active_at
             ) VALUES ${valuePlaceholders.join(", ")}`,
            ...params,
          );
        }

        if (ais.length > 0) {
          const routingRows: Array<{ humanId: string; aiId: string; updatedAt: number }> = [];
          for (const item of added) {
            for (const ai of ais) {
              routingRows.push({ humanId: item.id, aiId: ai.id, updatedAt: now });
            }
          }
          batchInsertRouting(this.ctx.storage.sql, routingRows);
        }

        for (const item of added) {
          this.broadcast({
            type: "participant_changed",
            participantId: item.id,
            state: "connected",
            at: now,
          });
        }
      } else {
        const added = await Promise.all(
          Array.from({ length: countToAdd }, (_, i) => {
            const index = existing.length + i;
            const name = simulatedName("ai", index);
            const aiId = crypto.randomUUID();
            const address = `ai/${slug(name)}`;
            const wakeName = name;
            return sha256(randomToken()).then((hash) => ({
              id: aiId,
              name,
              hash,
              address,
              wakeName,
            }));
          }),
        );

        const humans = this.ctx.storage.sql
          .exec<ParticipantRow>(
            "SELECT id FROM participants WHERE role = 'human' AND state != 'left'",
          )
          .toArray();

        const CHUNK_SIZE = 10;
        for (let i = 0; i < added.length; i += CHUNK_SIZE) {
          const chunk = added.slice(i, i + CHUNK_SIZE);
          const valuePlaceholders: string[] = [];
          const params: SqlStorageValue[] = [];
          for (const item of chunk) {
            valuePlaceholders.push(
              "(?, ?, 'ai', 'connected', ?, NULL, ?, 1, ?, ?, 'listening', ?)",
            );
            params.push(item.id, item.name, now, item.hash, item.address, item.wakeName, now);
          }
          this.ctx.storage.sql.exec(
            `INSERT INTO participants (
               id, display_name, role, state, joined_at, reconnect_until, rejoin_hash,
               simulated, address, wake_name, pipeline, last_active_at
             ) VALUES ${valuePlaceholders.join(", ")}`,
            ...params,
          );
        }

        if (humans.length > 0) {
          const routingRows: Array<{ humanId: string; aiId: string; updatedAt: number }> = [];
          for (const item of added) {
            for (const human of humans) {
              routingRows.push({ humanId: human.id, aiId: item.id, updatedAt: now });
            }
          }
          batchInsertRouting(this.ctx.storage.sql, routingRows);
        }

        for (const item of added) {
          this.broadcast({
            type: "participant_changed",
            participantId: item.id,
            state: "connected",
            at: now,
          });
        }
      }
    }

    const surplus = existing.slice(target);
    if (surplus.length > 0) {
      if (role === "human") {
        const now = Date.now();
        const surplusIds = surplus.map((p) => p.id);
        const placeholders = surplusIds.map(() => "?").join(", ");
        this.ctx.storage.sql.exec(
          `UPDATE participants SET state = 'left', reconnect_until = NULL WHERE id IN (${placeholders})`,
          ...surplusIds,
        );
        this.ctx.storage.sql.exec(
          `DELETE FROM routing WHERE human_id IN (${placeholders})`,
          ...surplusIds,
        );
        for (const id of surplusIds) {
          this.broadcast({
            type: "participant_changed",
            participantId: id,
            state: "left",
            at: now,
          });
        }
      } else {
        for (const item of surplus) {
          await this.removeAiInternal(item.id);
        }
      }
    }
  }

  private meta(): MetaRow | undefined {
    return this.ctx.storage.sql.exec<MetaRow>("SELECT * FROM room_meta LIMIT 1").toArray()[0];
  }

  private assertActive(): MetaRow {
    const meta = this.meta();
    if (!meta) throw roomError(404, "room_not_found", "Room is not initialised.");
    if (meta.expires_at <= Date.now()) {
      throw roomError(410, "room_expired", "Room has expired.");
    }
    return meta;
  }

  private participantRow(id: string): ParticipantRow | undefined {
    return this.ctx.storage.sql
      .exec<ParticipantRow>("SELECT * FROM participants WHERE id = ?", id)
      .toArray()[0];
  }

  private participant(id: string): Participant {
    const row = this.participantRow(id);
    if (!row) {
      throw roomError(404, "participant_not_found", "Participant does not exist in this room.");
    }
    return toParticipant(row);
  }

  private async assertHuman(credential: ParticipantCredential): Promise<ParticipantRow> {
    const row = await this.assertParticipant(credential.participantId, credential.rejoinToken);
    if (row.role !== "human") {
      throw roomError(403, "human_only", "Only a human participant can perform this action.");
    }
    return row;
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
    if (!row) {
      throw roomError(
        401,
        "participant_auth_failed",
        "Participant credentials are invalid or expired.",
      );
    }
    return row;
  }

  private floorQueue(): string[] {
    return this.ctx.storage.sql
      .exec<{ ai_id: string }>("SELECT ai_id FROM floor_queue ORDER BY queued_at")
      .toArray()
      .map((row) => row.ai_id);
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
      .map((row) => toRouting(row, this.routingEnforcement()));

    return {
      code: meta.code,
      createdAt: meta.created_at,
      expiresAt: meta.expires_at,
      participants,
      routing,
      transport: this.transportStatus(),
      aiToAi: {
        enabled: meta.ai_to_ai_enabled === 1,
        consecutiveTurns: meta.ai_to_ai_turns,
        turnCap: AI_TO_AI_TURN_CAP,
        cappedAt: meta.ai_to_ai_capped_at,
      } satisfies AiToAiState,
      floor: {
        holderId: meta.floor_holder,
        heldSince: meta.floor_since,
        queue: this.floorQueue(),
      } satisfies FloorState,
      presenter: {
        simulatedHumans: meta.simulated_humans,
        simulatedAis: meta.simulated_ais,
        scriptedResponses: meta.scripted_responses === 1,
      } satisfies PresenterConfiguration,
      composition: evaluateComposition(participants),
    };
  }

  /**
   * The room service never claims transport it has not traced, and never
   * downgrades the draft to reach a relay that happens to serve another one.
   *
   * Two separate facts (§11.2). Whether an endpoint is *configured* for the
   * pinned draft decides whether a real session is attempted. Whether a
   * browser-to-relay trace has been *recorded* decides whether the build says
   * transport works. Gate 1 exists to move the second one, and it cannot be
   * moved without first attempting the first.
   */
  private transportStatus(): TransportStatus {
    const draft = this.pinnedDraft();
    const endpoint = configValue(this.env.MOQ_RELAY_URL);
    const traceVerified = configFlag(this.env.MOQT_TRANSPORT_VERIFIED);
    const shared = {
      draft,
      endpoint,
      endpointName: endpointName(endpoint),
      traceVerified,
      discovery: this.discoveryMechanism(),
      routingEnforcement: this.routingEnforcement(),
    };

    if (!endpoint) {
      return {
        ...shared,
        availability: "draft_unavailable",
        failure: "draft_endpoint_missing",
        reason: `No relay endpoint is configured for MOQT draft ${draft}, so no session is attempted.`,
      };
    }
    if (!configuredRelayCredential(this.env.MOQ_RELAY_TOKEN)) {
      return {
        ...shared,
        availability: "relay_unavailable",
        failure: "relay_auth_unavailable",
        reason: `No provisioned credential is configured for ${shared.endpointName}, so no session is attempted.`,
      };
    }
    return {
      ...shared,
      availability: "available",
      failure: null,
      reason: traceVerified
        ? `MOQT draft ${draft} passed a browser-to-relay trace on ${shared.endpointName}.`
        : `MOQT draft ${draft} is configured on ${shared.endpointName} and will be attempted live. No Gate 1 browser-to-relay trace has been recorded yet, so transport is not claimed as verified.`,
    };
  }

  /**
   * The draft this deployment is pinned to, validated against the drafts the
   * build knows. An unrecognised configuration value falls back to the pinned
   * default rather than inventing a draft nothing can frame.
   */
  private pinnedDraft(): MoqDraft {
    return asMoqDraft(configValue(this.env.MOQT_DRAFT)) ?? PINNED_MOQT_DRAFT;
  }

  /** FR8 / Gate 1 output five. Cooperative until credential scoping is proven. */
  private routingEnforcement(): RoutingEnforcement {
    return configValue(this.env.MOQ_ROUTING_ENFORCEMENT) === "enforced"
      ? "enforced"
      : "cooperative";
  }

  /** FR7 / Gate 1 output four. The inspector states which one actually ran. */
  private discoveryMechanism(): DiscoveryMechanism {
    switch (configValue(this.env.MOQ_DISCOVERY)) {
      case "subscribe_namespace":
        return "subscribe_namespace";
      case "control_channel":
        return "control_channel";
      default:
        return "unknown";
    }
  }

  private emptyExpiryDue(meta: MetaRow, now: number): boolean {
    return meta.empty_since !== null && meta.empty_since + EMPTY_ROOM_EXPIRY_MS <= now;
  }

  private noteEmptiness(now: number): void {
    const humans = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM participants WHERE role = 'human' AND state != 'left'",
      )
      .one().count;
    if (humans > 0) {
      this.ctx.storage.sql.exec("UPDATE room_meta SET empty_since = NULL WHERE singleton = 1");
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE room_meta SET empty_since = ? WHERE singleton = 1 AND empty_since IS NULL",
      now,
    );
  }

  private async rescheduleAlarm(): Promise<void> {
    const meta = this.meta();
    if (!meta) return;
    const candidates = [meta.expires_at];
    if (meta.empty_since !== null) candidates.push(meta.empty_since + EMPTY_ROOM_EXPIRY_MS);
    const nextReconnect = this.ctx.storage.sql
      .exec<{ reconnect_until: number }>(
        "SELECT reconnect_until FROM participants WHERE state = 'reconnecting' AND reconnect_until IS NOT NULL ORDER BY reconnect_until LIMIT 1",
      )
      .toArray()[0]?.reconnect_until;
    if (nextReconnect !== undefined) candidates.push(nextReconnect);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment && !attachment.participantId && attachment.authDeadline !== null) {
        candidates.push(attachment.authDeadline);
      }
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private broadcast(event: RoomEvent): void {
    const encoded = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.participantId) {
        socket.send(encoded);
      }
    }
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
    simulated: row.simulated === 1,
    address: row.address,
    wakeName: row.wake_name,
    pipeline: row.pipeline,
    lastActiveAt: row.last_active_at,
  };
}

function toRouting(row: RoutingRow, enforcement: RoutingEnforcement): RoutingPreference {
  return {
    humanId: row.human_id,
    aiId: row.ai_id,
    hearsMe: row.hears_me === 1,
    iHearIt: row.i_hear_it === 1,
    enforcement,
    updatedAt: row.updated_at,
  };
}

const SIMULATED_HUMAN_NAMES = [
  "Grace",
  "Linus",
  "Radia",
  "Vint",
  "Katherine",
  "Barbara",
  "Alan",
  "Jean",
];
const SIMULATED_AI_NAMES = ["Atlas", "Sage", "Pilot", "Ember", "Quill", "Nomad"];

function simulatedName(role: "human" | "ai", index: number): string {
  const pool = role === "ai" ? SIMULATED_AI_NAMES : SIMULATED_HUMAN_NAMES;
  const base = pool[index % pool.length] ?? `${role === "ai" ? "AI" : "Guest"}`;
  const cycle = Math.floor(index / pool.length);
  const name = cycle === 0 ? base : `${base} ${cycle + 1}`;
  // H11 and AGENTS.md: simulation must be unmistakable, including in the name.
  return `${name} (simulated)`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function batchInsertRouting(
  sql: SqlStorage,
  rows: Array<{ humanId: string; aiId: string; updatedAt: number }>,
): void {
  if (rows.length === 0) return;
  const CHUNK_SIZE = 25;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const placeholders: string[] = [];
    const params: SqlStorageValue[] = [];
    for (const r of chunk) {
      placeholders.push("(?, ?, 0, 1, ?)");
      params.push(r.humanId, r.aiId, r.updatedAt);
    }
    sql.exec(
      `INSERT INTO routing (human_id, ai_id, hears_me, i_hear_it, updated_at)
       VALUES ${placeholders.join(", ")} ON CONFLICT(human_id, ai_id) DO NOTHING`,
      ...params,
    );
  }
}

function clampSimulated(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SIMULATED_PARTICIPANTS, Math.max(0, Math.trunc(value)));
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
