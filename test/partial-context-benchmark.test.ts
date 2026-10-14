import { describe, expect, it } from "vitest";

describe("partialContextAiIds lookup Benchmark", () => {
  it("compares Array.includes vs Set.has for checking participant partial context", () => {
    const numParticipants = 50;
    const numPartialContextAis = 20;
    const iterations = 100_000;

    const participants = Array.from({ length: numParticipants }, (_, i) => ({
      id: `participant-${i}`,
    }));

    const partialContextAiIds = Array.from(
      { length: numPartialContextAis },
      (_, i) => `participant-${i * 2}`,
    );

    // Array.includes approach (baseline)
    const startArray = performance.now();
    let arrayMatches = 0;
    for (let iter = 0; iter < iterations; iter++) {
      for (let p = 0; p < participants.length; p++) {
        const participant = participants[p];
        if (participant && partialContextAiIds.includes(participant.id)) {
          arrayMatches++;
        }
      }
    }
    const durationArray = performance.now() - startArray;

    // Set.has approach (optimized)
    const startSet = performance.now();
    let setMatches = 0;
    for (let iter = 0; iter < iterations; iter++) {
      const partialContextSet = new Set(partialContextAiIds);
      for (let p = 0; p < participants.length; p++) {
        const participant = participants[p];
        if (participant && partialContextSet.has(participant.id)) {
          setMatches++;
        }
      }
    }
    const durationSet = performance.now() - startSet;

    console.log(
      `[BENCHMARK] Array.includes over ${numParticipants} participants (${iterations} renders): ${durationArray.toFixed(2)} ms`,
    );
    console.log(
      `[BENCHMARK] Set.has over ${numParticipants} participants (${iterations} renders): ${durationSet.toFixed(2)} ms`,
    );
    console.log(`[BENCHMARK] Speedup: ${(durationArray / durationSet).toFixed(2)}x`);

    expect(arrayMatches).toEqual(setMatches);
  });
});
