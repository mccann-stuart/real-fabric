#!/usr/bin/env node

/** Keep only allow-listed Worker control-plane telemetry from `wrangler tail --format json`. */

import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    continue;
  }
  const request = item?.event?.request;
  let route = null;
  try {
    const path = new URL(request?.url).pathname;
    if (path === "/api/health" || path === "/api/rooms") {
      route = path;
    } else if (/^\/api\/rooms\/[A-Z0-9]{20}(?:\/[a-z-]+)?$/.test(path)) {
      route = path.replace(/[A-Z0-9]{20}/, ":room");
    } else {
      route = "other";
    }
  } catch {
    // Alarm and WebSocket events may have no fetch URL.
  }
  const logs = Array.isArray(item?.logs) ? item.logs : [];
  const structuredEvents = [];
  for (const log of logs) {
    for (const message of Array.isArray(log?.message) ? log.message : []) {
      if (typeof message !== "string") continue;
      try {
        const parsed = JSON.parse(message);
        if (typeof parsed?.event === "string" && /^[a-z_]+$/.test(parsed.event)) {
          structuredEvents.push({
            event: parsed.event,
            ...(typeof parsed.code === "string" && /^[a-z_]+$/.test(parsed.code)
              ? { code: parsed.code }
              : {}),
            ...(Number.isInteger(parsed.status) ? { status: parsed.status } : {}),
          });
        }
      } catch {
        // Free-text logs are deliberately not retained.
      }
    }
  }
  const safe = {
    at: Number.isFinite(item?.eventTimestamp) ? item.eventTimestamp : Date.now(),
    outcome:
      typeof item?.outcome === "string" && /^[a-z_]+$/.test(item.outcome)
        ? item.outcome
        : "unknown",
    route,
    method: /^(GET|POST|HEAD|OPTIONS)$/.test(request?.method) ? request.method : null,
    status: Number.isInteger(item?.event?.response?.status) ? item.event.response.status : null,
    exceptionNames: Array.isArray(item?.exceptions)
      ? item.exceptions
          .map((error) => error?.name)
          .filter((name) => typeof name === "string" && /^[A-Za-z]{1,64}$/.test(name))
      : [],
    structuredEvents,
  };
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}
