## 2026-08-26 - Cloudflare Durable Object SQLite Variable Limit
**Learning:** Cloudflare Workers Durable Object SQLite `sql.exec` enforces a maximum limit of 100 bound SQL parameters per query execution (`too many SQL variables`).
**Action:** When batching multi-row `INSERT` statements into SQLite in Durable Objects, calculate `CHUNK_SIZE` based on column parameter count to ensure `CHUNK_SIZE * params_per_row < 100` (e.g. max 12 rows for 7 parameters/row, max 30 rows for 3 parameters/row).

## 2026-08-26 - Set-based Routing Matrix Seeding in DO SQLite
**Learning:** Seeding relational many-to-many matrices (such as human-AI routing pairs) in Durable Object SQLite is measurably faster when performed via a single set-based SQL query (`INSERT INTO ... SELECT ... CROSS JOIN ... ON CONFLICT DO NOTHING`) rather than mapping JS arrays and running multiple chunked batch INSERT queries.
**Action:** Use set-based `INSERT INTO ... SELECT` with `CROSS JOIN` for matrix generation to minimize JS allocations and SQLite query overhead.
