## 2026-10-17 - Universal Length Bounds on WebSocket Messages
**Vulnerability:** WebSocket message size check was scoped only to unauthenticated initial handshake messages, leaving active authenticated connections vulnerable to memory allocation overhead from oversized control messages (CWE-400 / CWE-770).
**Learning:** Security bounds on message or payload length must apply to all incoming frames regardless of socket state (pre- or post-authentication) at the top of the message handler.
**Prevention:** Enforce length upper-bound checks globally on raw message text or buffers before state-dependent parsing or control flow logic.

## 2026-10-17 - String Input Validation Order of Operations
**Vulnerability:** Input validation functions ran `.trim()` or regex scans on raw untruncated string fields before checking upper-bound length limits (`maximumLength * 4 + 64`), enabling potential whitespace inflation and memory allocation overhead on large strings (CWE-20 / CWE-400).
**Learning:** Checking string presence and raw length bounds (`value.length > max`) MUST happen before executing computationally expensive operations like `.trim()` or regex pattern testing.
**Prevention:** In input validation helpers, place raw length bound checks immediately after primitive type checks, before any transformation or regex evaluation.
