## 2026-08-26 - Cloudflare Durable Object SQLite Variable Limit
**Learning:** Cloudflare Workers Durable Object SQLite `sql.exec` enforces a maximum limit of 100 bound SQL parameters per query execution (`too many SQL variables`).
**Action:** When batching multi-row `INSERT` statements into SQLite in Durable Objects, calculate `CHUNK_SIZE` based on column parameter count to ensure `CHUNK_SIZE * params_per_row < 100` (e.g. max 12 rows for 7 parameters/row, max 30 rows for 3 parameters/row).

## 2026-09-05 - Relational CROSS JOIN for Missing SQLite Batch Inserts
**Learning:** Instead of constructing N×M missing relationship rows in JS and batching them with parameterized multi-row `INSERT` statements, a single SQL query with `CROSS JOIN` and `ON CONFLICT DO NOTHING` executes directly in SQLite in 1 query execution with 1 bound parameter.
**Action:** Use SQL `INSERT INTO rel SELECT ... FROM tableA CROSS JOIN tableB ... ON CONFLICT DO NOTHING` for missing relational pair initialization instead of JS loop batching.
