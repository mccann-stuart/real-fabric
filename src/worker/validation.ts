export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function readJsonObject(
  request: Request,
  maxBytes: number = 8192,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected an application/json request.");
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(declaredLength) && declaredLength > maxBytes) {
      throw new HttpError(
        413,
        "payload_too_large",
        `Request body exceeds maximum permitted size of ${maxBytes} bytes.`,
      );
    }
  }

  let text: string;
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new HttpError(
        413,
        "payload_too_large",
        `Request body exceeds maximum permitted size of ${maxBytes} bytes.`,
      );
    }
    text = new TextDecoder().decode(buffer);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Failed to read request body.");
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
