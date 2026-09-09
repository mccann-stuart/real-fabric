import type { RelayCredentialStatus } from "../shared/contracts";

/**
 * Cloudflare draft-16 accepts only tokens registered against an isolated relay.
 * It does not know how to validate application-signed claims, so the Worker
 * must return a provisioned Cloudflare token rather than inventing one.
 *
 * The secret is returned only in create/join responses, held in browser memory
 * and appended to the WebTransport URL inside `MoqTransportAdapter`. It never
 * appears in the shareable room snapshot, telemetry or application logs.
 */
export interface RelayCredentialInspection {
  status: RelayCredentialStatus;
  credential: string | null;
}

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Fail closed before distributing a malformed or known-expired configured token.
 * The relay remains the signature authority; decoding `exp` here is not JWT
 * verification and does not resolve the relay-wide scope of this credential.
 */
export function inspectRelayCredential(
  secret: string | undefined,
  nowMs = Date.now(),
): RelayCredentialInspection {
  const credential = secret?.trim();
  if (!credential) return { status: "missing", credential: null };

  const segments = credential.split(".");
  if (segments.length !== 3 || segments.some((segment) => !JWT_SEGMENT.test(segment))) {
    return { status: "invalid", credential: null };
  }

  try {
    const payload = segments[1];
    if (!payload) return { status: "invalid", credential: null };
    const claims: unknown = JSON.parse(decodeBase64Url(payload));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
      return { status: "invalid", credential: null };
    }
    const expiresAtSeconds = (claims as Record<string, unknown>).exp;
    if (
      typeof expiresAtSeconds !== "number" ||
      !Number.isFinite(expiresAtSeconds) ||
      expiresAtSeconds <= 0
    ) {
      return { status: "invalid", credential: null };
    }
    if (nowMs / 1_000 >= expiresAtSeconds) {
      return { status: "expired", credential: null };
    }
    return { status: "available", credential };
  } catch {
    return { status: "invalid", credential: null };
  }
}

export function configuredRelayCredential(
  secret: string | undefined,
  nowMs = Date.now(),
): string | null {
  return inspectRelayCredential(secret, nowMs).credential;
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
