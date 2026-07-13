import type { SessionUpstreamProbe } from "openclaw/plugin-sdk/session-catalog";
import { describe, expect, it, vi } from "vitest";
import type { CodexTurn } from "./app-server/protocol.js";
import {
  checkCodexUpstreamActivity,
  classifyCodexUpstreamTurns,
} from "./session-upstream-activity.js";

function probe(overrides: Partial<SessionUpstreamProbe> = {}): SessionUpstreamProbe {
  return {
    sessionKey: "agent:main:adopted:codex",
    agentId: "main",
    threadId: "thread-1",
    hostId: "gateway:local",
    upstreamKind: "codex-app-server",
    upstreamRef: { connectionFingerprint: "connection-1", threadId: "thread-1" },
    marker: { turnId: "turn-1" },
    ...overrides,
  };
}

function turn(id: string, itemTypes: string[], startedAt: number): CodexTurn {
  return {
    id,
    startedAt,
    items: itemTypes.map((type, index) => ({
      id: `${id}-item-${index}`,
      type,
    })) as CodexTurn["items"],
  };
}

describe("Codex upstream activity", () => {
  it("counts userMessage turns and uses the latest human timestamp", () => {
    expect(
      classifyCodexUpstreamTurns({
        probe: probe(),
        turns: [
          turn("turn-4", ["agentMessage"], 400),
          turn("turn-3", ["userMessage", "agentMessage"], 300),
          turn("turn-2", ["agentMessage"], 200),
          turn("turn-1", ["userMessage"], 100),
        ],
      }),
    ).toEqual({
      sessionKey: "agent:main:adopted:codex",
      occurredAt: 300_000,
      humanTurns: 1,
      nextMarker: { turnId: "turn-4" },
      dedupeToken: "turn-4",
    });
  });

  it("uses the pinned connection and a bounded descending summary page", async () => {
    const listTurnPage = vi.fn(async () => ({
      data: [turn("turn-2", ["userMessage"], 200), turn("turn-1", [], 100)],
    }));
    const control: Parameters<typeof checkCodexUpstreamActivity>[1] = {
      connectionFingerprint: "connection-1",
      listTurnPage,
      withPinnedConnection: async (run) => await run(control),
    };

    await expect(
      checkCodexUpstreamActivity([probe()], control, async () => "thread-canonical"),
    ).resolves.toEqual([expect.objectContaining({ dedupeToken: "turn-2", humanTurns: 1 })]);
    expect(listTurnPage).toHaveBeenCalledWith({
      threadId: "thread-canonical",
      limit: 100,
      sortDirection: "desc",
      itemsView: "summary",
    });
  });

  it("isolates a stale thread from healthy probes", async () => {
    const listTurnPage = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === "thread-stale") {
        throw new Error("thread missing");
      }
      return { data: [turn("turn-2", ["userMessage"], 200), turn("turn-1", [], 100)] };
    });
    const control: Parameters<typeof checkCodexUpstreamActivity>[1] = {
      connectionFingerprint: "connection-1",
      listTurnPage,
      withPinnedConnection: async (run) => await run(control),
    };

    await expect(
      checkCodexUpstreamActivity(
        [probe({ threadId: "thread-stale" }), probe({ sessionKey: "healthy" })],
        control,
      ),
    ).resolves.toEqual([expect.objectContaining({ sessionKey: "healthy" })]);
  });
});
