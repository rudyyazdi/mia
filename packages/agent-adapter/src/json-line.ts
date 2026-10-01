import { redactSensitivePairs, redactString, redactValue } from "@mia/protocol";

/** One line of a runtime's JSON-lines output: its parsed JSON, or the text of a line that is not JSON. */
export type JsonLine = { ok: true; json: unknown; raw: string } | { ok: false; raw: string };

/** Reads one output line; null for a blank one. */
export const readJsonLine = (line: string): JsonLine | null => {
  const raw = line.trim();
  if (raw.length === 0) return null;
  try {
    return { ok: true, json: JSON.parse(raw), raw };
  } catch {
    // The parser's message is not kept: it quotes a slice of the input ("password":hunter2), which no redaction can
    // reliably key, and the raw line already carries the evidence.
    return { ok: false, raw };
  }
};

/**
 * The line as it may be retained or shown: JSON is redacted by key and by value, because a credential under a
 * sensitive key need not look like a secret. A line that is not JSON, typically one cut short when the runtime died
 * mid-write, is redacted by key as text (`redactSensitivePairs`) and by value. The redacted form of a JSON line is
 * re-serialised, not verbatim: duplicate keys collapse and numbers beyond double precision round.
 */
export const redactJsonLine = (line: JsonLine): string =>
  line.ok ? JSON.stringify(redactValue(line.json)) : redactString(redactSensitivePairs(line.raw));
