const SAFE_ADJECTIVES = [
  "Amber",
  "Bright",
  "Calm",
  "Clear",
  "Clever",
  "Crisp",
  "Curious",
  "Daring",
  "Eager",
  "Early",
  "Fair",
  "Friendly",
  "Gentle",
  "Golden",
  "Happy",
  "Helpful",
  "Honest",
  "Jolly",
  "Kind",
  "Lively",
  "Lucky",
  "Merry",
  "Mighty",
  "Nimble",
  "Noble",
  "Peaceful",
  "Playful",
  "Proud",
  "Quick",
  "Quiet",
  "Radiant",
  "Ready",
  "Silver",
  "Steady",
  "Sunny",
  "Swift",
  "Tidy",
  "Vivid",
  "Warm",
  "Wise",
] as const;

const SAFE_NOUNS = [
  "Badger",
  "Beacon",
  "Birch",
  "Brook",
  "Cedar",
  "Comet",
  "Coral",
  "Cove",
  "Crane",
  "Dune",
  "Falcon",
  "Fern",
  "Finch",
  "Forest",
  "Fox",
  "Garden",
  "Grove",
  "Harbour",
  "Hazel",
  "Heron",
  "Hill",
  "Island",
  "Juniper",
  "Lark",
  "Maple",
  "Meadow",
  "Moon",
  "Oak",
  "Ocean",
  "Orchid",
  "Otter",
  "Owl",
  "Pebble",
  "Pine",
  "Pond",
  "Poppy",
  "Raven",
  "Reef",
  "River",
  "Robin",
  "Rowan",
  "Sparrow",
  "Star",
  "Stone",
  "Summit",
  "Swan",
  "Tide",
  "Valley",
  "Willow",
  "Wren",
] as const;

/** The curated Cartesian set contains exactly 2,000 two-word display names. */
export const SAFE_DISPLAY_NAME_COUNT = SAFE_ADJECTIVES.length * SAFE_NOUNS.length;

export function safeDisplayNameAt(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= SAFE_DISPLAY_NAME_COUNT) {
    throw new RangeError(
      `Safe display-name index must be between 0 and ${SAFE_DISPLAY_NAME_COUNT - 1}.`,
    );
  }

  const adjective = SAFE_ADJECTIVES[Math.floor(index / SAFE_NOUNS.length)];
  const noun = SAFE_NOUNS[index % SAFE_NOUNS.length];
  if (!adjective || !noun)
    throw new RangeError(`Safe display-name index '${index}' is unavailable.`);
  return `${adjective} ${noun}`;
}

export function generateRandomDisplayName(): string {
  return safeDisplayNameAt(secureRandomIndex(SAFE_DISPLAY_NAME_COUNT));
}

function secureRandomIndex(upperBound: number): number {
  const range = 0x1_0000_0000;
  const unbiasedLimit = range - (range % upperBound);
  const values = new Uint32Array(1);

  while (true) {
    crypto.getRandomValues(values);
    const value = values[0];
    if (value !== undefined && value < unbiasedLimit) return value % upperBound;
  }
}
