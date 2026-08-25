export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected an application/json request.");
  }

  try {
    const value: unknown = await request.json();
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
