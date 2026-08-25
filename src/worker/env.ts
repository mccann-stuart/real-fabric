/**
 * `wrangler types` narrows each `vars` entry to the literal currently in
 * `wrangler.jsonc`, which makes comparing it against any other value a type
 * error. Reading through here widens back to `string`, so the Gate 1 values can
 * move in configuration without a code change — which is the point of holding
 * them in configuration.
 */
export function configValue(value: string): string {
  return value;
}

export function configFlag(value: string): boolean {
  return configValue(value) === "true";
}
