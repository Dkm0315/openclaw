import type { CodexThread, CodexTurn } from "./app-server/protocol.js";

export type CodexUpstreamBaseline = {
  turnId: string | null;
  userMessageCount: number;
};

function lastTerminalTurn(
  thread: CodexThread,
  normalizeTurnId: (value: unknown) => string | undefined,
): CodexTurn | undefined {
  for (let index = (thread.turns?.length ?? 0) - 1; index >= 0; index -= 1) {
    const turn = thread.turns?.[index];
    const turnId = normalizeTurnId(turn?.id);
    if (!turn || !turnId) {
      continue;
    }
    if (turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed") {
      return { ...turn, id: turnId };
    }
  }
  return undefined;
}

export function codexUpstreamBaseline(
  thread: CodexThread,
  normalizeTurnId: (value: unknown) => string | undefined,
): CodexUpstreamBaseline {
  const turn = lastTerminalTurn(thread, normalizeTurnId);
  return {
    turnId: turn?.id ?? null,
    userMessageCount: turn?.items.filter((item) => item.type === "userMessage").length ?? 0,
  };
}
