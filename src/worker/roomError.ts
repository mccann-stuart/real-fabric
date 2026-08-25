/**
 * Durable Object RPC reliably carries an error's `message` but not its class,
 * so a status and code travel inside the message behind a sentinel and are
 * unpacked on the Worker side.
 *
 * The alternative — a plain throw — surfaces every refusal as HTTP 500, which
 * would make "participant credentials are invalid" indistinguishable from a
 * genuine server fault. H14 is about failures being distinguishable, and that
 * applies to the API as much as to the room.
 */

const SENTINEL = "RF-ROOM-ERROR";

export function roomError(status: number, code: string, message: string): Error {
  return new Error(`${SENTINEL}|${status}|${code}|${message}`);
}

export interface DecodedRoomError {
  status: number;
  code: string;
  message: string;
}

export function decodeRoomError(error: unknown): DecodedRoomError | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(
    new RegExp(`^${SENTINEL}\\|(\\d{3})\\|([a-z_]+)\\|([\\s\\S]*)$`),
  );
  if (!match?.[1] || !match[2] || match[3] === undefined) return null;
  return { status: Number(match[1]), code: match[2], message: match[3] };
}
