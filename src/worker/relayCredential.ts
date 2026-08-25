/**
 * §8: short-lived, least-privilege relay credentials, minted server-side.
 *
 * The credential is a signed statement of exactly one participant's rights in
 * exactly one room, valid for the room's remaining lifetime and no longer. It
 * travels to the browser in the join response and reaches the relay as a MOQT
 * AUTHORIZATION_TOKEN setup parameter — never in a URL, so it cannot survive in
 * a share link, a referrer header or browser history.
 *
 * `MOQ_ROUTING_ENFORCEMENT` stays `cooperative` until the eventual draft-20
 * relay proves that it enforces token scope. Minting the scoped form means that
 * proof can remain a configuration change rather than a credential redesign.
 */

/** Never outlives the room's 20-minute hard stop (§8). */
export const CREDENTIAL_MAX_TTL_MS = 20 * 60_000;

export interface RelayCredentialClaims {
  /** Opaque room identifier, as the relay sees it. */
  room: string;
  /** Opaque participant identifier, as the relay sees it. */
  participant: string;
  /** The one namespace this participant may publish into. */
  publish: string;
  /** The namespace prefix this participant may subscribe under. */
  subscribe: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * Signs the claims with the deployment's relay secret. Without a secret the
 * credential is still scoped and still short-lived, but it is unsigned — so it
 * is marked as such rather than presented as something a relay could trust.
 */
export async function mintRelayCredential(
  claims: RelayCredentialClaims,
  secret: string | undefined,
): Promise<string> {
  const body = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  if (!secret) return `v1.unsigned.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `v1.${base64Url(new Uint8Array(signature))}.${body}`;
}

export function credentialLifetimeMs(roomExpiresAt: number, now: number): number {
  return Math.max(0, Math.min(CREDENTIAL_MAX_TTL_MS, roomExpiresAt - now));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
