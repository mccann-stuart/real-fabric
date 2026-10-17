## 2026-10-17 - String Input Validation Order of Operations
**Vulnerability:** Input validation functions ran `.trim()` or regex scans on raw untruncated string fields before checking upper-bound length limits (`maximumLength * 4 + 64`), enabling potential whitespace inflation and memory allocation overhead on large strings (CWE-20 / CWE-400).
**Learning:** Checking string presence and raw length bounds (`value.length > max`) MUST happen before executing computationally expensive operations like `.trim()` or regex pattern testing.
**Prevention:** In input validation helpers, place raw length bound checks immediately after primitive type checks, before any transformation or regex evaluation.
