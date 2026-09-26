## 2026-09-10 - Cloudflare Durable Object SQLite Probing Resource Allocation
**Vulnerability:** Probing unknown room codes instantiated `Room` Durable Objects whose constructor executed DDL statements (`CREATE TABLE IF NOT EXISTS`), persistently allocating Cloudflare DO SQLite storage for invalid codes (SEC-11).
**Learning:** Cloudflare DO constructors run whenever `getByName()` is called. Executing DDL in the constructor creates SQLite database instances before verifying if the room is initialised.
**Prevention:** Defer DDL schema creation to explicit initialization methods (`initialise()`), and handle missing table exceptions gracefully in read queries (`meta()`).

## 2026-09-10 - Room Presenter Authorization Enforcement
**Vulnerability:** Any human joining a room could execute global presenter and AI lifecycle controls (adding/removing AIs, forcing AI pipeline state, controlling floor queue, changing AI-to-AI modes, reshaping simulation) because `assertHuman` only checked role === 'human' (SEC-02 / CWE-862).
**Learning:** Room creator identity was not bound to room state in the Durable Object. Frontend UI flags (`presenterMode`) alone are non-enforcing client-side controls.
**Prevention:** Store `owner_id` on initial join in `room_meta` and enforce `assertPresenter` in Durable Object RPC methods for all presenter/AI management operations.

## 2026-09-16 - Read-Only Session Capability Enforcement
**Vulnerability:** Read-only / narrow clients attempted microphone capture and publication (`getUserMedia`) regardless of capability support or read-only settings (SEC-12 / CWE-359).
**Learning:** Client-side UI read-only flags alone do not prevent lower-level audio capture controllers from calling `navigator.mediaDevices.getUserMedia` if previously authorized.
**Prevention:** Inspect local capture capabilities (`inspectCaptureSupport()`) before initiating microphone capture in `RoomSession.ts` and transition unsupported/read-only clients directly to `listen_only`.

## 2026-09-17 - SQL Identifier Sanitization in DROP TABLE
**Vulnerability:** Dynamic table removal in test/maintenance DDL used string interpolation without validating table name identifiers against an allow-list or quoting characters.
**Learning:** Parameter binding does not apply to DDL table identifiers in SQLite; unvalidated dynamic identifiers create injection surfaces even in migration helpers.
**Prevention:** Validate identifier strings strictly against alphanumeric and underscore character patterns before constructing DDL queries.

## 2026-09-17 - Session Key Normalization and Rejoin Window Enforcement
**Vulnerability:** Inconsistent storage keying (`storeSession` with raw room code vs `loadSession`/`clearSession` with normalised code) stranded reclaim tokens, while `storedAt` was never validated against `REJOIN_WINDOW_MS` on reload.
**Learning:** Independent helper functions that build storage keys separately can silently desynchronise under unnormalised user input, and unused timestamp fields allow expired sessions to attempt invalid backend reclaims.
**Prevention:** Unify session storage key generation through a single `sessionKey()` helper, and enforce client-side `REJOIN_WINDOW_MS` checks that fail closed on expired or missing timestamps before attempting reclaim.

## 2026-09-17 - Telemetry Payload Allow-Listing (AC-14)
**Vulnerability:** Top-level key deny-listing in telemetry sanitisation allowed arbitrary nested payloads and free-text strings (such as display names or transcripts) to pass into reports without scrubbing.
**Learning:** Deny-list filtering on unstructured event objects fails when object schemas evolve or nesting is introduced.
**Prevention:** Use an explicit allow-list of permitted keys (`at`, `type`, `participantId`, `trackId`, `value`) with strict type validation, reject free-text strings, and re-filter upon export.

## 2026-09-17 - AI Floor Queue Active Participant Validation
**Vulnerability:** Unvalidated AI floor targets and un-joined floor queue queries allowed stale or left AI participant identifiers to remain in the floor queue and block turn promotion when an active AI released the floor (SEC-03 / CWE-20).
**Learning:** `floor_queue` rows persisted without referential constraints to active participant states (`state != 'left'`), allowing removed AIs to stay queued.
**Prevention:** Join `participants` in `floorQueue()` queries to filter for active AI participants (`role = 'ai' AND state != 'left'`), and explicitly purge stale queue entries in `releaseFloorInternal`.
