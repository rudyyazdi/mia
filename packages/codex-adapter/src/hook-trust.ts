import type { HooksList } from "./protocol.ts";

/**
 * Whether Codex will run Mia's gate hook, from its `hooks/list`: Codex runs a configured hook only once its definition
 * is trusted, by hash, in the config. Mia writes the hook at every launch, so it trusts it then, by the hash Codex
 * reports; a hook that is missing or disabled leaves every call ungated, so the session must not start.
 */
export type HookTrust =
  | { kind: "trusted" }
  | { kind: "untrusted"; key: string; hash: string }
  | { kind: "missing" }
  | { kind: "disabled" };

export const gateHookTrust = (
  list: HooksList,
  hook: { source: string; command: string },
): HookTrust => {
  const entry = list.data
    .flatMap((listed) => listed.hooks)
    .find((listed) => listed.sourcePath === hook.source && listed.command === hook.command);
  if (!entry) return { kind: "missing" };
  if (!entry.enabled) return { kind: "disabled" };
  if (entry.trustStatus === "trusted") return { kind: "trusted" };
  return { kind: "untrusted", key: entry.key, hash: entry.currentHash };
};

/** The `config/batchWrite` parameters that trust one hook by its current hash and reload the config. */
export const trustEdit = (key: string, hash: string): unknown => ({
  edits: [
    { keyPath: "hooks.state", value: { [key]: { trusted_hash: hash } }, mergeStrategy: "upsert" },
  ],
  reloadUserConfig: true,
});
