import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import type { SessionCatalogProvider, SessionUpstreamProbe } from "../plugins/session-catalog.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listSessionStateEventsSince, registerSessionStateWatch } from "./session-state-events.js";
import { upsertSessionUpstreamLink } from "./session-upstream-links.js";
import { runSessionUpstreamMonitorTick } from "./session-upstream-monitor.js";

const tempDirs: string[] = [];
const watcherSessionKey = "agent:main:main";

function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-session-upstream-monitor-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createLink(
  sessionKey: string,
  catalogId: string,
  database: ReturnType<typeof createDatabaseOptions>,
  watched = true,
) {
  upsertSessionUpstreamLink(
    {
      sessionKey,
      agentId: "main",
      catalogId,
      hostId: "gateway:local",
      threadId: `thread-${catalogId}`,
      upstreamKind: catalogId === "claude" ? "claude-cli" : "codex-app-server",
      upstreamRef: { source: catalogId },
      marker: { offset: 0 },
    },
    database,
  );
  if (watched) {
    registerSessionStateWatch({ watcherSessionKey, targetSessionKey: sessionKey }, database);
  }
}

function provider(
  id: string,
  checkUpstreamActivity: NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>,
): SessionCatalogProvider {
  return {
    id,
    label: id,
    list: async () => [],
    read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    checkUpstreamActivity,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("session upstream monitor", () => {
  it("records watched activity once and advances its marker", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:watched";
    const unwatched = "agent:main:adopted:unwatched";
    createLink(watched, "claude", database);
    createLink(unwatched, "claude", database, false);
    const checkUpstreamActivity = vi.fn(async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({
        sessionKey: probe.sessionKey,
        occurredAt: 2_000,
        humanTurns: 1,
        nextMarker: { offset: 8 },
        dedupeToken: "8",
      })),
    );
    const claude = provider("claude", checkUpstreamActivity);
    const loadEntry = vi.fn(() => undefined);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 3_000,
      loadEntry,
    });
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 4_000,
      loadEntry,
    });

    expect(checkUpstreamActivity).toHaveBeenCalledTimes(2);
    expect(checkUpstreamActivity.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ sessionKey: watched, marker: { offset: 0 } }),
    ]);
    expect(checkUpstreamActivity.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ sessionKey: watched, marker: { offset: 8 } }),
    ]);
    const events = listSessionStateEventsSince(watched, "main", 0, 20, database).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        kind: "human_direct_message",
        summary: "human message via claude",
        occurredAt: 2_000,
      }),
    );
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT dedupe_key FROM session_state_events WHERE session_key = ?")
        .get(watched),
    ).toEqual({ dedupe_key: `upstream:${watched}:8` });
  });

  it("isolates provider failures", async () => {
    const database = createDatabaseOptions();
    const codexSession = "agent:main:adopted:codex";
    createLink("agent:main:adopted:claude", "claude", database);
    createLink(codexSession, "codex", database);
    const codexCheck = vi.fn(async () => [
      {
        sessionKey: codexSession,
        occurredAt: 5_000,
        humanTurns: 1,
        nextMarker: { turnId: "turn-2" },
        dedupeToken: "turn-2",
      },
    ]);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("claude", async () => {
          throw new Error("broken");
        }),
        provider("codex", codexCheck),
      ],
      loadEntry: () => undefined,
    });

    expect(codexCheck).toHaveBeenCalledOnce();
    expect(listSessionStateEventsSince(codexSession, "main", 0, 20, database).events).toHaveLength(
      1,
    );
  });

  it("consumes self-echo activity without recording it", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:self-echo";
    createLink(sessionKey, "claude", database);
    const check = vi.fn(async (probes: SessionUpstreamProbe[]) =>
      (probes[0]?.marker as { offset?: number } | null)?.offset === 0
        ? [
            {
              sessionKey,
              occurredAt: 10_000,
              humanTurns: 1,
              nextMarker: { offset: 12 },
              dedupeToken: "12",
            },
          ]
        : [],
    );
    const claude = provider("claude", check);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      loadEntry: () => ({ sessionId: "session-self", lastActivityAt: 10_010 }) as never,
      isRunActive: () => false,
    });
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      loadEntry: () => undefined,
    });

    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
    expect(check.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ marker: { offset: 12 } })]);
  });
});
