#!/usr/bin/env node

/**
 * Bounded, synthetic-audio browser load for a deployed Real Fabric room.
 *
 * This is an operator tool, not a product audio path. It drives the actual
 * create/join/Start audio controls in isolated Chromium contexts and records
 * only allow-listed counters. No response bodies, credentials, invite codes,
 * audio samples, transcript text or browser network traces are saved.
 *
 * Supply Playwright as external tooling with REAL_FABRIC_PLAYWRIGHT_PATH when
 * it is not available as a normal Node resolution from this checkout.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, freemem, loadavg } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const PRODUCTION_ORIGIN = "https://real-fabric.booms-17-brooms.workers.dev";
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOM_LIFETIME_MS = 20 * 60_000;
const MAX_RAMP_MS = 7 * 60_000;
const SAMPLE_INTERVAL_MS = 1_000;
const STAGE_COUNTS = [2, 5, 10, 15, 20];

function safeErrorSummary(error) {
  const message = error instanceof Error ? error.message : "";
  const known = [
    ["No subscription for received track alias", "missing_track_alias_subscription"],
    ["No full track name for received track alias", "missing_track_alias_name"],
    ["Received RESET_STREAM", "reset_stream"],
    ["Connection lost", "connection_lost"],
    ["WebTransport session is terminated", "session_terminated"],
  ];
  const category = known.find(([phrase]) => message.includes(phrase))?.[1] ?? "other";
  const name = /^[A-Za-z]{1,40}$/.test(error?.name) ? error.name : "Error";
  return `${name}:${category}`;
}

function safeApiRoute(path) {
  if (path === "/api/health" || path === "/api/rooms") return path;
  if (/^\/api\/rooms\/[A-Z0-9]{20}(?:\/[a-z-]+)?$/.test(path)) {
    return path.replace(/[A-Z0-9]{20}/, ":room");
  }
  return "other";
}

function optionsFrom(args) {
  const options = {
    origin: PRODUCTION_ORIGIN,
    clients: 20,
    browserGroups: 4,
    stageSeconds: 20,
    holdSeconds: 600,
    speechProfile: "turn-taking",
    outputDir: resolve(
      "output/playwright/production20",
      new Date().toISOString().replaceAll(":", "-"),
    ),
    chrome: DEFAULT_CHROME,
    executeProduction: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--execute-production") {
      options.executeProduction = true;
      continue;
    }
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${arg}`);
    switch (arg) {
      case "--origin":
        options.origin = new URL(value).origin;
        break;
      case "--clients":
        options.clients = Number(value);
        break;
      case "--browser-groups":
        options.browserGroups = Number(value);
        break;
      case "--stage-seconds":
        options.stageSeconds = Number(value);
        break;
      case "--hold-seconds":
        options.holdSeconds = Number(value);
        break;
      case "--speech-profile":
        options.speechProfile = value;
        break;
      case "--output-dir":
        options.outputDir = resolve(value);
        break;
      case "--chrome":
        options.chrome = resolve(value);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.origin === PRODUCTION_ORIGIN && !options.executeProduction) {
    throw new Error("Production traffic requires --execute-production.");
  }
  if (!Number.isInteger(options.clients) || options.clients < 2 || options.clients > 20) {
    throw new Error("--clients must be an integer from 2 to 20 for this bounded run.");
  }
  if (
    !Number.isInteger(options.browserGroups) ||
    options.browserGroups < 1 ||
    options.browserGroups > options.clients
  ) {
    throw new Error("--browser-groups must be an integer from 1 to --clients.");
  }
  for (const key of ["stageSeconds", "holdSeconds"]) {
    if (!Number.isInteger(options[key]) || options[key] < 0) {
      throw new Error(`--${key} must be a non-negative integer.`);
    }
  }
  if (options.speechProfile !== "turn-taking" && options.speechProfile !== "overlap") {
    throw new Error("--speech-profile must be turn-taking or overlap.");
  }
  if (options.holdSeconds * 1_000 + MAX_RAMP_MS + 60_000 > ROOM_LIFETIME_MS) {
    throw new Error("The hold and maximum ramp need to fit inside the 20-minute room lifetime.");
  }
  return options;
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    const externalPath = process.env.REAL_FABRIC_PLAYWRIGHT_PATH;
    if (externalPath) return require(externalPath);
    throw new Error(
      "Playwright is required as external tooling. Set REAL_FABRIC_PLAYWRIGHT_PATH to its package directory.",
    );
  }
}

function syntheticWav(path, groupIndex, browserGroups, speechProfile) {
  const sampleRate = 48_000;
  const seconds = speechProfile === "overlap" ? 4 : browserGroups * 5;
  const samples = sampleRate * seconds;
  const pcm = Buffer.alloc(samples * 2);
  let seed = groupIndex + 1;
  for (let sample = 0; sample < samples; sample += 1) {
    const t = sample / sampleRate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    const syllable = 0.42 + 0.4 * Math.sin(2 * Math.PI * (2.7 + groupIndex * 0.13) * t);
    const carrier =
      Math.sin(2 * Math.PI * (180 + groupIndex * 29) * t) +
      0.35 * Math.sin(2 * Math.PI * (390 + groupIndex * 37) * t);
    const speaking = speechProfile === "overlap" || (t >= groupIndex * 5 && t < groupIndex * 5 + 3);
    const value = speaking
      ? Math.max(-1, Math.min(1, syllable * (0.14 * carrier + 0.05 * noise)))
      : 0;
    pcm.writeInt16LE(Math.round(value * 32767), sample * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]), { flag: "wx" });
}

const webTransportProbe = () => {
  const Original = window.WebTransport;
  if (typeof Original !== "function") return;
  const sessions = [];
  Object.defineProperty(window, "__realFabricLoadTransports", { value: sessions });
  window.WebTransport = new Proxy(Original, {
    construct(target, argumentsList, newTarget) {
      const session = Reflect.construct(target, argumentsList, newTarget);
      sessions.push(session);
      return session;
    },
  });
};

// Entry has already created or joined the participant before it navigates to
// /room. The room hook immediately re-presents that same token and consumes a
// second per-IP join-rate event. Reuse the entry response exactly once for this
// first mount, leaving later real reload/reclaim calls untouched. The response
// (including the credential) stays in the browser's memory and is never logged.
const initialJoinCoalescer = () => {
  const realFetch = window.fetch.bind(window);
  let entryResponse = null;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "POST" || url.origin !== location.origin) return realFetch(input, init);
    const isCreate = url.pathname === "/api/rooms";
    const isJoin = /^\/api\/rooms\/[A-Z0-9]{20}\/join$/.test(url.pathname);
    if (!isCreate && !isJoin) return realFetch(input, init);
    const isRejoin =
      isJoin && typeof init?.body === "string" && init.body.includes('"rejoinToken"');
    if (isRejoin && entryResponse) {
      const cached = entryResponse;
      entryResponse = null;
      return cached;
    }
    const response = await realFetch(input, init);
    if (response.ok && !isRejoin) entryResponse = response.clone();
    return response;
  };
};

async function observe(page) {
  return page.evaluate(async () => {
    const number = (raw) => {
      if (!raw || raw.includes("Not exposed")) return null;
      const value = Number.parseFloat(
        raw.match(/-?\d[\d,]*(?:\.\d+)?/)?.[0]?.replaceAll(",", "") ?? "",
      );
      return Number.isFinite(value) ? value : null;
    };
    const tables = [...document.querySelectorAll("table.comparison-table")];
    const readings = {};
    for (const table of tables) {
      for (const row of table.querySelectorAll("tbody tr")) {
        const key = row.querySelector("th")?.textContent?.trim();
        const raw = row
          .querySelectorAll("td")[1]
          ?.querySelector(".measurement")
          ?.textContent?.trim();
        if (key && raw) readings[key] = raw;
      }
    }
    const summary = [...document.querySelectorAll(".inspector__summary b")].map(
      (node) => node.textContent?.trim() ?? "",
    );
    const transports = window.__realFabricLoadTransports ?? [];
    const transport = [];
    for (const session of transports) {
      if (typeof session.getStats !== "function") {
        transport.push({ unavailable: true, reason: "api_not_exposed" });
        continue;
      }
      try {
        const stats = await session.getStats();
        const fields = [
          "bytesSent",
          "bytesSentOverhead",
          "bytesReceived",
          "packetsSent",
          "packetsReceived",
          "packetsLost",
          "bytesLost",
          "smoothedRtt",
          "minRtt",
          "rttVariation",
        ];
        const selected = {};
        for (const key of fields) {
          if (typeof stats[key] === "number" && Number.isFinite(stats[key])) {
            selected[key] = stats[key];
          }
        }
        transport.push(selected);
      } catch (error) {
        transport.push({ unavailable: true, errorName: error?.name ?? "UnknownError" });
      }
    }
    return {
      failureCodes: [...document.querySelectorAll(".failure-banner[data-failure]")].map((node) =>
        node.getAttribute("data-failure"),
      ),
      roomAlertCount: document.querySelectorAll(".room-status-stack [role='alert']").length,
      objectTablePresent: tables.some(
        (table) => table.querySelector("caption")?.textContent === "Object delivery",
      ),
      inspectorSummaryPresent: summary.length === 2,
      publishedTracks: number(summary.find((item) => item.startsWith("Uplink"))),
      subscribedTracks: number(summary.find((item) => item.startsWith("Downlink"))),
      publishedObjects: number(readings["Published objects"]),
      inboundObjects: number(readings["Inbound objects"]),
      outboundObjectRate: number(readings["Outbound object rate"]),
      inboundObjectRate: number(readings["Inbound object rate"]),
      meanOutboundObjectBytes: number(readings["Mean outbound object size"]),
      meanInboundObjectBytes: number(readings["Mean object size"]),
      lateDrops: number(readings["Late drops"]),
      concealedFrames: number(readings["Concealed frames"]),
      worstBufferMs: number(readings["Worst track buffer"]),
      activeDecoders: number(readings["Active decoders"]),
      capacityStep: number(readings["Capacity state"]?.match(/Protection step (\d+)/)?.[1] ?? "0"),
      dtx: readings["Opus DTX"] ?? null,
      transport,
    };
  });
}

async function firstObjectSources(page, idsToLabels) {
  await page.getByRole("tab", { name: /Events/ }).click({ timeout: 5_000 });
  try {
    const sourceIds = await page.locator(".event-stream li").evaluateAll((items) =>
      items
        .filter((item) => item.querySelector("b")?.textContent?.includes("first_object"))
        .map(
          (item) => item.querySelector("span")?.textContent?.match(/audio\/([A-Za-z0-9-]+)/)?.[1],
        )
        .filter(Boolean),
    );
    return [...new Set(sourceIds.map((id) => idsToLabels.get(id)).filter(Boolean))];
  } finally {
    await page
      .getByRole("tab", { name: /Objects/ })
      .click({ timeout: 5_000 })
      .catch(() => undefined);
  }
}

async function startClient(browser, origin, roomCode, index, requests) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["microphone"], { origin });
  const page = await context.newPage();
  await page.addInitScript(initialJoinCoalescer);
  await page.addInitScript(webTransportProbe);
  const label = `C${String(index + 1).padStart(2, "0")}`;
  const actor = { label, context, page, id: null, last: null, errors: 0, errorSummaries: {} };
  page.on("pageerror", (error) => {
    actor.errors += 1;
    const safe = safeErrorSummary(error);
    actor.errorSummaries[safe] = (actor.errorSummaries[safe] ?? 0) + 1;
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
    if (response.status() >= 400) {
      requests.push({
        at: Date.now(),
        client: label,
        route: safeApiRoute(url.pathname),
        status: response.status(),
      });
    }
  });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("#entry-display-name").fill(`Synthetic ${label}`);
    if (roomCode) {
      await page.locator("#entry-room-code").fill(roomCode);
      const joinResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/join"),
        { timeout: 30_000 },
      );
      await page.getByRole("button", { name: "Join room", exact: true }).click();
      const response = await joinResponse;
      if (!response.ok()) throw new Error(`${label}: join returned HTTP ${response.status()}`);
    } else {
      const createResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/rooms",
        { timeout: 30_000 },
      );
      await page.getByRole("button", { name: "Create demo room", exact: true }).click();
      const response = await createResponse;
      if (!response.ok()) throw new Error(`${label}: create returned HTTP ${response.status()}`);
    }
    await page.waitForURL(/\/room\/[A-Z0-9]{20}$/, { timeout: 30_000 });
    const enteredCode = page.url().match(/\/room\/([A-Z0-9]{20})$/)?.[1];
    if (!enteredCode) throw new Error(`${label}: room navigation did not expose a code`);
    actor.id = await page.evaluate((code) => {
      const raw = sessionStorage.getItem(`real-fabric:${code}`);
      return raw ? JSON.parse(raw).participantId : null;
    }, enteredCode);
    await page.getByRole("button", { name: "Start audio", exact: true }).click({ timeout: 30_000 });
    await page.getByRole("tab", { name: /Objects/ }).click();
    return { actor, roomCode: enteredCode };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function stageCounts(clientCount) {
  return [...new Set([...STAGE_COUNTS.filter((count) => count <= clientCount), clientCount])].sort(
    (a, b) => a - b,
  );
}

async function waitForStage(actors, target, seconds) {
  const deadline = Date.now() + Math.max(30_000, seconds * 1_000);
  while (Date.now() < deadline) {
    const latest = await Promise.allSettled(actors.map(({ page }) => observe(page)));
    const allReady = latest.every(
      (result) =>
        result.status === "fulfilled" &&
        result.value.publishedTracks === 1 &&
        result.value.subscribedTracks === target - 1 &&
        result.value.publishedObjects > 0 &&
        result.value.inboundObjects > 0,
    );
    if (allReady) return true;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  return false;
}

async function leave(actor) {
  try {
    await actor.page
      .locator(".room-topbar")
      .getByRole("button", { name: "Leave room" })
      .click({ timeout: 5_000 });
    await actor.page
      .locator("dialog")
      .getByRole("button", { name: "Leave room" })
      .click({ timeout: 5_000 });
    await actor.page.waitForURL((url) => url.pathname === "/", { timeout: 5_000 });
  } catch {
    // Closing the context still sends the page-hide leave hint.
  }
  await actor.context.close().catch(() => undefined);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const { chromium } = loadPlaywright();
  mkdirSync(options.outputDir, { recursive: true });
  const runId = randomUUID();
  const sampleFile = createWriteStream(resolve(options.outputDir, "client-samples.ndjson"), {
    flags: "wx",
  });
  const actors = [];
  const browsers = [];
  const requests = [];
  const stages = [];
  const seenFirstObjects = new Map();
  const syntheticFiles = [];
  let roomCode = null;
  let createdAt = null;
  let samplerStop = false;
  let sampler = null;
  let outcome = "incomplete";
  const startedAt = Date.now();
  let latestSamples = [];
  const writeSample = (sample) => sampleFile.write(`${JSON.stringify(sample)}\n`);
  const removeSyntheticFiles = () => {
    for (const path of syntheticFiles) {
      try {
        unlinkSync(path);
      } catch {
        // Cleanup must not hide test evidence.
      }
    }
  };

  const shutdown = () => {
    samplerStop = true;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", removeSyntheticFiles);
  try {
    console.log(
      `Run ${runId}: ${options.clients} clients, ${options.browserGroups} Chrome groups, ${options.speechProfile} speech, ${availableParallelism()} host CPUs.`,
    );
    for (let group = 0; group < options.browserGroups; group += 1) {
      const wav = resolve(options.outputDir, `synthetic-${group + 1}.wav`);
      syntheticWav(wav, group, options.browserGroups, options.speechProfile);
      syntheticFiles.push(wav);
      browsers.push(
        await chromium.launch({
          executablePath: options.chrome,
          headless: true,
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-audio-capture=${wav}`,
            "--autoplay-policy=no-user-gesture-required",
          ],
        }),
      );
    }

    sampler = (async () => {
      while (!samplerStop) {
        const at = Date.now();
        const settled = await Promise.allSettled(actors.map((actor) => observe(actor.page)));
        latestSamples = settled.map((result, index) => {
          const actor = actors[index];
          const sample = {
            at,
            client: actor?.label,
            ...(result.status === "fulfilled" ? result.value : { unavailable: true }),
            pageErrors: actor?.errors ?? 0,
            hostLoad1m: loadavg()[0],
            hostFreeMemoryBytes: freemem(),
          };
          if (actor) actor.last = sample;
          writeSample(sample);
          return sample;
        });
        const delay = SAMPLE_INTERVAL_MS - (Date.now() - at);
        if (delay > 0) await new Promise((done) => setTimeout(done, delay));
      }
    })();

    for (const target of stageCounts(options.clients)) {
      if (samplerStop) break;
      while (actors.length < target) {
        if (samplerStop) break;
        const index = actors.length;
        const browser = browsers[index % browsers.length];
        const joined = await startClient(browser, options.origin, roomCode, index, requests);
        roomCode = joined.roomCode;
        if (createdAt === null) createdAt = Date.now();
        actors.push(joined.actor);
        console.log(
          `${joined.actor.label}: joined and requested audio (${actors.length}/${options.clients}).`,
        );
        if (requests.some((item) => item.status >= 500 || item.status === 429)) {
          throw new Error("Production API reported 5xx or rate limiting during the ramp.");
        }
        if (Date.now() - createdAt > MAX_RAMP_MS) {
          throw new Error("Ramp exceeded the seven-minute limit; no ten-minute hold will fit.");
        }
      }
      const ready = await waitForStage(actors, target, Math.max(30, options.stageSeconds));
      const stage = { at: Date.now(), participants: target, ready };
      stages.push(stage);
      console.log(
        `Stage ${target}: ${ready ? "all publishers and receiving counts observed" : "not fully ready"}.`,
      );
      const idsToLabels = new Map(actors.map((actor) => [actor.id, actor.label]));
      const sourceChecks = await Promise.allSettled(
        actors.map((actor) => firstObjectSources(actor.page, idsToLabels)),
      );
      for (const [index, actor] of actors.entries()) {
        const checked = sourceChecks[index];
        const sources = checked?.status === "fulfilled" ? checked.value : [];
        const seen = seenFirstObjects.get(actor.label) ?? new Set();
        for (const source of sources) seen.add(source);
        seenFirstObjects.set(actor.label, seen);
      }
      if (options.stageSeconds > 0) {
        await new Promise((done) => setTimeout(done, options.stageSeconds * 1_000));
      }
    }

    if (!samplerStop && actors.length === options.clients) {
      const remaining = ROOM_LIFETIME_MS - (Date.now() - createdAt);
      if (remaining < options.holdSeconds * 1_000 + 60_000) {
        throw new Error("The room has insufficient lifetime for the requested hold and teardown.");
      }
      const until = Date.now() + options.holdSeconds * 1_000;
      while (!samplerStop && Date.now() < until) {
        if (requests.some((item) => item.status >= 500 || item.status === 429)) {
          throw new Error("Production API reported 5xx or rate limiting during the hold.");
        }
        await new Promise((done) => setTimeout(done, 1_000));
      }
      outcome = samplerStop ? "interrupted" : "hold_complete";
    }

    const idsToLabels = new Map(actors.map((actor) => [actor.id, actor.label]));
    const firstObjects = [];
    const sourceChecks = await Promise.allSettled(
      actors.map((actor) => firstObjectSources(actor.page, idsToLabels)),
    );
    for (const [index, actor] of actors.entries()) {
      const checked = sourceChecks[index];
      const sources = checked?.status === "fulfilled" ? checked.value : [];
      const seen = seenFirstObjects.get(actor.label) ?? new Set();
      for (const source of sources) seen.add(source);
      firstObjects.push({ client: actor.label, sources: [...seen].sort() });
    }
    const summary = {
      format: "real-fabric-production-audio-load-v1",
      runId,
      outcome,
      startedAt,
      finishedAt: Date.now(),
      origin: options.origin,
      clientsRequested: options.clients,
      clientsJoined: actors.length,
      browserGroups: options.browserGroups,
      speechProfile: options.speechProfile,
      initialMountRejoinCoalesced: true,
      stages,
      expectedDirectedEdges: actors.length * (actors.length - 1),
      firstObjectDirectedEdges: firstObjects.reduce((sum, item) => sum + item.sources.length, 0),
      firstObjects,
      lastSamples: latestSamples,
      pageErrorSummaries: Object.fromEntries(
        actors.map((actor) => [actor.label, actor.errorSummaries]),
      ),
      apiFailures: requests,
      note: "Counts and WebTransport stats are browser-observed. WebTransport byte fields can be unavailable. Continuous per-track counts are not exposed by the deployed UI.",
    };
    writeFileSync(resolve(options.outputDir, "summary.json"), JSON.stringify(summary, null, 2), {
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        outcome,
        firstObjectDirectedEdges: summary.firstObjectDirectedEdges,
        expectedDirectedEdges: summary.expectedDirectedEdges,
        outputDir: options.outputDir,
      }),
    );
  } catch (error) {
    outcome = "failed";
    writeFileSync(
      resolve(options.outputDir, "partial-summary.json"),
      JSON.stringify(
        {
          format: "real-fabric-production-audio-load-v1",
          runId,
          outcome,
          startedAt,
          finishedAt: Date.now(),
          clientsRequested: options.clients,
          clientsJoined: actors.length,
          speechProfile: options.speechProfile,
          initialMountRejoinCoalesced: true,
          stages,
          lastSamples: latestSamples,
          pageErrorSummaries: Object.fromEntries(
            actors.map((actor) => [actor.label, actor.errorSummaries]),
          ),
          apiFailures: requests,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    throw error;
  } finally {
    samplerStop = true;
    if (sampler) await sampler.catch(() => undefined);
    await Promise.allSettled(actors.map(leave));
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    removeSyntheticFiles();
    await new Promise((done) => sampleFile.end(done));
    process.removeListener("exit", removeSyntheticFiles);
  }
}

main().catch((error) => {
  const firstLine = error instanceof Error ? error.message.split("\n")[0] : String(error);
  console.error(
    firstLine.replaceAll(/[A-Z0-9]{20}/g, "[room]").replaceAll(/https:\/\/[^\s]+/g, "[url]"),
  );
  process.exitCode = 1;
});
