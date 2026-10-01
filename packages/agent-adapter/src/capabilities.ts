import type { RuntimeKind } from "./config.ts";

/** Where a runtime's credential was found: each adapter detects its own runtime's sources. */
export type CredentialSource = "ANTHROPIC_API_KEY" | "claude_credentials_file" | "none_detected";

/**
 * What a runtime's adapter found without contacting a model, checked before the server serves. Printed verbatim as a
 * JSON report by the probe tool, hence snake_case.
 */
export interface StaticCapabilities {
  runtime: RuntimeKind;
  executable_resolved: string | null;
  runtime_version: string | null;
  /** Each launch option or feature the adapter relies on, and whether this runtime has it. */
  flags_present: Record<string, boolean>;
  credential_source: CredentialSource;
  /** Why provenance cannot retain the runtime's effective instructions: what the runtime keeps from Mia. */
  undisclosed_instructions: string;
  node_version: string;
  adapter_version: string;
  errors: string[];
}
