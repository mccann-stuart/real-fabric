/**
 * Cloudflare draft-16 accepts only tokens registered against an isolated relay.
 * It does not know how to validate application-signed claims, so the Worker
 * must return a provisioned Cloudflare token rather than inventing one.
 *
 * The secret is returned only in create/join responses, held in browser memory
 * and appended to the WebTransport URL inside `MoqTransportAdapter`. It never
 * appears in the shareable room snapshot, telemetry or application logs.
 */
export function configuredRelayCredential(secret: string | undefined): string | null {
  const credential = secret?.trim();
  return credential ? credential : null;
}
