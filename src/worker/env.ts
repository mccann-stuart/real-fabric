/**
 * `wrangler types` narrows each `vars` entry to the literal currently in
 * `wrangler.jsonc`, which makes comparing it against any other value a type
 * error. Reading through here widens back to `string`, so the Gate 1 values can
 * move in configuration without a code change — which is the point of holding
 * them in configuration.
 */
export function configValue(value: string): string {
  return value.trim();
}

export function configFlag(value: string): boolean {
  return configValue(value) === "true";
}

/**
 * Secrets never appear in `wrangler.jsonc`, so `wrangler types` cannot see
 * them. This is the declaration-merge point the generated file leaves open for
 * exactly that case — one optional secret, not a second copy of `Env`.
 */
declare global {
  interface Env {
    /** Provisioned Cloudflare MoQ publish+subscribe token; never put in vars. */
    MOQ_RELAY_TOKEN?: string;
  }
}
