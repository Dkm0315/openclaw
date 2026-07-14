import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
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
        dedupeId: "8",
      })),
    );
    const claude = provider("claude", checkUpstreamActivity);
    const loadEntry = vi.fn(() => ({ sessionId: "session-watched" }) as never);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 3_000,
      loadEntry,
      loadOwnRecentUserTexts: async () => [],
    });
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 4_000,
      loadEntry,
      loadOwnRecentUserTexts: async () => [],
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
    expect(events[0]?.payload).toBeUndefined();
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT dedupe_key FROM session_state_events WHERE session_key = ?")
        .get(watched),
    ).toEqual({ dedupe_key: `upstream:${watched}:8` });
  });

  it("preserves a coalesced upstream burst count in the event payload", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:burst";
    createLink(sessionKey, "codex", database);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("codex", async () => [
          {
            sessionKey,
            occurredAt: 2_000,
            humanTurns: 3,
            nextMarker: { turnId: "turn-3", userMessageCount: 1 },
            dedupeId: "turn-3:1",
          },
        ]),
      ],
      loadEntry: () => ({ sessionId: "session-burst" }) as never,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([
      expect.objectContaining({
        kind: "human_direct_message",
        payload: { turns: 3 },
      }),
    ]);
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
        dedupeId: "turn-2",
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
      loadEntry: () => ({ sessionId: "session" }) as never,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(codexCheck).toHaveBeenCalledOnce();
    expect(listSessionStateEventsSince(codexSession, "main", 0, 20, database).events).toHaveLength(
      1,
    );
  });

  it("defers active runs without advancing their marker", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:active";
    createLink(sessionKey, "claude", database);
    const check = vi.fn(async (_probes: SessionUpstreamProbe[]) => []);
    const claude = provider("claude", check);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      loadEntry: () => ({ sessionId: "session-active" }) as never,
      isRunActive: () => true,
      loadOwnRecentUserTexts: async () => [],
    });
    expect(check).not.toHaveBeenCalled();

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      loadEntry: () => ({ sessionId: "session-active" }) as never,
      isRunActive: () => false,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(check).toHaveBeenCalledWith([expect.objectContaining({ marker: { offset: 0 } })]);
  });

  it("defers activity when a run starts during the provider scan", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:active-race";
    createLink(sessionKey, "claude", database);
    let active = false;
    const check = vi.fn(async (_probes: SessionUpstreamProbe[]) => {
      active = true;
      return [
        {
          sessionKey,
          occurredAt: 2_000,
          humanTurns: 1,
          nextMarker: { offset: 12 },
          dedupeId: "12",
        },
      ];
    });

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-active-race" }) as never,
      isRunActive: () => active,
      loadOwnRecentUserTexts: async () => [],
    });
    active = false;
    check.mockResolvedValueOnce([]);
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-active-race" }) as never,
      isRunActive: () => active,
      loadOwnRecentUserTexts: async () => [],
    });

    expect(check.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ marker: { offset: 0 } })]);
    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
  });

  it("advances scan-only markers without recording an event", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:scan-only";
    createLink(sessionKey, "claude", database);
    const check = vi
      .fn<NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>>()
      .mockResolvedValueOnce([{ sessionKey, humanTurns: 0, nextMarker: { offset: 12 } }])
      .mockResolvedValueOnce([]);

    const options = {
      ...database,
      providers: [provider("claude", check)],
      loadEntry: () => ({ sessionId: "session-scan" }) as never,
      loadOwnRecentUserTexts: async () => [],
    };
    await runSessionUpstreamMonitorTick(options);
    await runSessionUpstreamMonitorTick(options);

    expect(check.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ marker: { offset: 12 } })]);
    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
  });

  it("supplies provenance text so a matching upstream prompt advances without an event", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:provenance";
    const sessionId = "session-provenance";
    await upsertSessionEntry(
      { agentId: "main", sessionKey, env: database.env },
      { sessionId, updatedAt: 1 },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, env: database.env },
      {
        cwd: process.cwd(),
        eventId: "user-message",
        message: {
          role: "user",
          content: "visible prompt",
          __openclaw: {
            mirrorOrigin: "codex-app-server",
            upstreamUserText: " exact   decorated prompt ",
          },
        },
      },
    );
    createLink(sessionKey, "claude", database);
    const check = vi.fn(async (probes: SessionUpstreamProbe[]) => [
      {
        sessionKey,
        humanTurns: probes[0]?.ownRecentUserTexts.includes("exact decorated prompt") ? 0 : 1,
        nextMarker: { offset: 20 },
      },
    ]);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [provider("claude", check)],
      isRunActive: () => false,
    });

    expect(check).toHaveBeenCalledWith([
      expect.objectContaining({ ownRecentUserTexts: ["exact decorated prompt"] }),
    ]);
    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toEqual([]);
  });

  it("records an external prompt five seconds after OpenClaw activity", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:recent-external";
    createLink(sessionKey, "claude", database);

    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("claude", async () => [
          {
            sessionKey,
            occurredAt: 10_000,
            humanTurns: 1,
            nextMarker: { offset: 24 },
            dedupeId: "24",
          },
        ]),
      ],
      loadEntry: () => ({ sessionId: "session-external", lastActivityAt: 5_000 }) as never,
      isRunActive: () => false,
      loadOwnRecentUserTexts: async () => ["OpenClaw prompt"],
    });

    expect(listSessionStateEventsSince(sessionKey, "main", 0, 20, database).events).toHaveLength(1);
  });
});
