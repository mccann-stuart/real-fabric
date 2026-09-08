## 2026-08-26 - Cloudflare Durable Object SQLite Variable Limit
**Learning:** Cloudflare Workers Durable Object SQLite `sql.exec` enforces a maximum limit of 100 bound SQL parameters per query execution (`too many SQL variables`).
**Action:** When batching multi-row `INSERT` statements into SQLite in Durable Objects, calculate `CHUNK_SIZE` based on column parameter count to ensure `CHUNK_SIZE * params_per_row < 100` (e.g. max 12 rows for 7 parameters/row, max 30 rows for 3 parameters/row).

## 2026-09-08 - Set-based SQL JOIN vs Chunked JS Batch Inserts
**Learning:** Constructing JS object arrays and batching individual `INSERT` rows over DO SQLite produces significant latency due to repeated query parsing and parameter binding overhead across multiple statements.
**Action:** Prefer set-based `INSERT INTO table SELECT ... FROM table JOIN ...` queries for cross-participant initialization, passing chunked ID parameters to stay well under the 100-variable bound parameter limit while executing the entire join in SQLite C++.
