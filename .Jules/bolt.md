## 2026-08-26 - Cloudflare Durable Object SQLite Variable Limit
**Learning:** Cloudflare Workers Durable Object SQLite `sql.exec` enforces a maximum limit of 100 bound SQL parameters per query execution (`too many SQL variables`).
**Action:** When batching multi-row `INSERT` statements into SQLite in Durable Objects, calculate `CHUNK_SIZE` based on column parameter count to ensure `CHUNK_SIZE * params_per_row < 100` (e.g. max 12 rows for 7 parameters/row, max 30 rows for 3 parameters/row).

## 2026-09-08 - Set-based SQL JOIN vs Chunked JS Batch Inserts
**Learning:** Constructing JS object arrays and batching individual `INSERT` rows over DO SQLite produces significant latency due to repeated query parsing and parameter binding overhead across multiple statements.
**Action:** Prefer set-based `INSERT INTO table SELECT ... FROM table JOIN ...` queries for cross-participant initialization, passing chunked ID parameters to stay well under the 100-variable bound parameter limit while executing the entire join in SQLite C++.

## 2026-09-09 - Fast Binary Audio Frame Header Packing
**Learning:** Encoding and decoding 22-byte audio object frame headers via direct TypedArray `DataView` operations avoids object allocation, string conversions and GC thrashing on 50 Hz real-time audio paths.
**Action:** Use fixed-size binary buffers and explicit endianness reading/writing for high-frequency transport envelopes.

## 2026-09-09 - Participant Card Rendering Isolation
**Learning:** Updating audio meter levels at 50 Hz forces full React re-renders across the participant grid if audio level state is colocated with membership and routing state.
**Action:** Memoize `ParticipantCard` and isolate real-time signal meter visual updates into dedicated sub-components so layout and routing components do not re-render.

## Next steps and vision statements

Forward-looking performance engineering and optimization targets:

1. **Zero-copy WebCodecs to WebTransport streaming (Vision target):** Pipe encoded Opus chunks directly to WebTransport stream writers without intermediate buffer copies.
2. **Dedicated worker audio processing (Vision target):** Offload jitter buffering, packet loss concealment, and decode scheduling to a dedicated Web Worker to isolate media processing from main-thread UI rendering.
3. **Zero-allocation AudioWorklet buffer recycling (Next step):** Maintain a pre-allocated transferable buffer ring for AudioWorklet capture and mixer nodes to eliminate real-time memory allocations.
