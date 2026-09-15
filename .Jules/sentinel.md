## 2026-09-10 - Cloudflare Durable Object SQLite Probing Resource Allocation
**Vulnerability:** Probing unknown room codes instantiated `Room` Durable Objects whose constructor executed DDL statements (`CREATE TABLE IF NOT EXISTS`), persistently allocating Cloudflare DO SQLite storage for invalid codes (SEC-11).
**Learning:** Cloudflare DO constructors run whenever `getByName()` is called. Executing DDL in the constructor creates SQLite database instances before verifying if the room is initialised.
**Prevention:** Defer DDL schema creation to explicit initialization methods (`initialise()`), and handle missing table exceptions gracefully in read queries (`meta()`).

## 2026-09-10 - Room Presenter Authorization Enforcement
**Vulnerability:** Any human joining a room could execute global presenter and AI lifecycle controls (adding/removing AIs, forcing AI pipeline state, controlling floor queue, changing AI-to-AI modes, reshaping simulation) because `assertHuman` only checked role === 'human' (SEC-02 / CWE-862).
**Learning:** Room creator identity was not bound to room state in the Durable Object. Frontend UI flags (`presenterMode`) alone are non-enforcing client-side controls.
**Prevention:** Store `owner_id` on initial join in `room_meta` and enforce `assertPresenter` in Durable Object RPC methods for all presenter/AI management operations.
