## 2026-09-10 - Cloudflare Durable Object SQLite Probing Resource Allocation
**Vulnerability:** Probing unknown room codes instantiated `Room` Durable Objects whose constructor executed DDL statements (`CREATE TABLE IF NOT EXISTS`), persistently allocating Cloudflare DO SQLite storage for invalid codes (SEC-11).
**Learning:** Cloudflare DO constructors run whenever `getByName()` is called. Executing DDL in the constructor creates SQLite database instances before verifying if the room is initialised.
**Prevention:** Defer DDL schema creation to explicit initialization methods (`initialise()`), and handle missing table exceptions gracefully in read queries (`meta()`).
