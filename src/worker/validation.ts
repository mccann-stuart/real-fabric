export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Maximum allowed JSON body payload size (32 KiB) to prevent resource exhaustion (CWE-400 / CWE-770). */
const MAX_BODY_BYTES = 32 * 1024;

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected an application/json request.");
  }

  // Security: Check Content-Length header to reject oversized payloads before buffering
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "Request body exceeds maximum allowed size.");
    }
  }

  let text: string;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_BODY_BYTES) {
            await reader.cancel("payload_too_large");
            throw new HttpError(
              413,
              "payload_too_large",
              "Request body exceeds maximum allowed size.",
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const concatenated = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      concatenated.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(concatenated);
  } else {
    text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "Request body exceeds maximum allowed size.");
    }
  }

  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export function requiredString(
  body: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "invalid_request", `Field '${field}' must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximumLength) {
    throw new HttpError(
      400,
      "invalid_request",
      `Field '${field}' must be at most ${maximumLength} characters.`,
    );
  }
  return trimmed;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new HttpError(
      400,
      "invalid_request",
      `Field '${field}' must be a string of at most ${maximumLength} characters.`,
    );
  }
  return value;
}

export function requiredBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_request", `Field '${field}' must be a boolean.`);
  }
  return value;
}

export function requiredInteger(
  body: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(
      400,
      "invalid_request",
      `Field '${field}' must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function requiredEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = body[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(
      400,
      "invalid_request",
      `Field '${field}' must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}
