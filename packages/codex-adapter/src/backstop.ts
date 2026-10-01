/**
 * Mia's answer to a request Codex makes of its client. Mia decides every tool call through the gate hook and runs
 * Codex under approval policy `never`, so Codex should ask nothing; whatever it does ask is refused: every approval is
 * declined, no permission is granted, an elicitation is declined, and no user input is given.
 */
export type BackstopAnswer =
  { kind: "result"; result: unknown } | { kind: "refuse"; message: string };

const DECLINED: Readonly<Record<string, unknown>> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  execCommandApproval: { decision: { denied: { rejection: "Mia decides every call itself." } } },
  applyPatchApproval: { decision: { denied: { rejection: "Mia decides every call itself." } } },
  "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
  "mcpServer/elicitation/request": { action: "decline", content: null, _meta: null },
  "item/tool/requestUserInput": { answers: {} },
  "item/tool/call": { contentItems: [], success: false },
};

export const backstopAnswer = (method: string): BackstopAnswer =>
  Object.hasOwn(DECLINED, method)
    ? { kind: "result", result: DECLINED[method] }
    : { kind: "refuse", message: `Mia does not serve ${method}` };
