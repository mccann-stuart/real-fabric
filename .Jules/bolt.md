## 2026-08-26 - Cloudflare Durable Object SQLite Variable Limit
**Learning:** Cloudflare Workers Durable Object SQLite `sql.exec` enforces a maximum limit of 100 bound SQL parameters per query execution (`too many SQL variables`).
**Action:** When batching multi-row `INSERT` statements into SQLite in Durable Objects, calculate `CHUNK_SIZE` based on column parameter count to ensure `CHUNK_SIZE * params_per_row < 100` (e.g. max 12 rows for 7 parameters/row, max 30 rows for 3 parameters/row).
