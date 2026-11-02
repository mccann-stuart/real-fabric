## 2026-10-17 - String Input Validation Order of Operations
**Vulnerability:** Input validation functions ran `.trim()` or regex scans on raw untruncated string fields before checking upper-bound length limits (`maximumLength * 4 + 64`), enabling potential whitespace inflation and memory allocation overhead on large strings (CWE-20 / CWE-400).
**Learning:** Checking string presence and raw length bounds (`value.length > max`) MUST happen before executing computationally expensive operations like `.trim()` or regex pattern testing.
**Prevention:** In input validation helpers, place raw length bound checks immediately after primitive type checks, before any transformation or regex evaluation.

## 2026-10-18 - Fail-Closed Room Presenter Authorization
**Vulnerability:** In `assertPresenter`, checking `if (!meta || (meta.owner_id !== null && meta.owner_id !== row.id))` failed open when `room_meta.owner_id` was `null` / unassigned, permitting any human participant to execute presenter and AI lifecycle controls (CWE-862).
**Learning:** Checking that a resource owner is not null before checking inequality (`owner !== null && owner !== user`) inadvertently grants access when `owner` is null. Authorization checks on ownership must verify positive possession (`owner === user`) or fail closed (`!meta || owner !== user`).
**Prevention:** In authorization guards, never assume a null owner field means unconstrained access. Always ensure missing or unassigned ownership rejects callers by default.
