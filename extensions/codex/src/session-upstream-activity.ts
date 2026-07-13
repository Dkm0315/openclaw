import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionCatalogProvider,
  SessionUpstreamActivity,
  SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
  CodexTurn,
} from "./app-server/protocol.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
} from "./app-server/session-binding.js";
import type { CodexSessionCatalogControl } from "./session-catalog.js";

const CODEX_UPSTREAM_TURN_LIMIT = 100;

type CodexUpstreamControl = {
  connectionFingerprint?: string;
  withPinnedConnection<T>(run: (control: CodexUpstreamControl) => Promise<T>): Promise<T>;
  listTurnPage(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
};

function markerTurnId(probe: SessionUpstreamProbe): string | null | undefined {
  if (!isRecord(probe.marker)) {
    return undefined;
  }
  return probe.marker.turnId === null || typeof probe.marker.turnId === "string"
    ? probe.marker.turnId
    : undefined;
}

function upstreamConnectionFingerprint(probe: SessionUpstreamProbe): string | undefined {
  return isRecord(probe.upstreamRef) && typeof probe.upstreamRef.connectionFingerprint === "string"
    ? probe.upstreamRef.connectionFingerprint
    : undefined;
}

export function classifyCodexUpstreamTurns(params: {
  probe: SessionUpstreamProbe;
  turns: CodexTurn[];
  now?: number;
}): SessionUpstreamActivity | undefined {
  const marker = markerTurnId(params.probe);
  if (marker === undefined || params.turns.length === 0) {
    return undefined;
  }
  const markerIndex = marker === null ? -1 : params.turns.findIndex((turn) => turn.id === marker);
  const newTurns = markerIndex < 0 ? params.turns : params.turns.slice(0, markerIndex);
  if (newTurns.length === 0) {
    return undefined;
  }
  const humanTurnEntries = newTurns.filter((turn) =>
    turn.items.some((item) => item.type === "userMessage"),
  );
  if (humanTurnEntries.length === 0) {
    return undefined;
  }
  const newest = newTurns[0];
  const newestHumanTurn = humanTurnEntries[0];
  if (!newest?.id || !newestHumanTurn) {
    return undefined;
  }
  const timestampSeconds = newestHumanTurn.completedAt ?? newestHumanTurn.startedAt;
  const occurredAt =
    typeof timestampSeconds === "number" && Number.isFinite(timestampSeconds)
      ? timestampSeconds * 1000
      : (params.now ?? Date.now());
  const activityId = newest.id;
  return {
    sessionKey: params.probe.sessionKey,
    occurredAt,
    humanTurns: humanTurnEntries.length,
    nextMarker: { turnId: activityId },
    dedupeToken: activityId,
  };
}

export async function checkCodexUpstreamActivity(
  probes: SessionUpstreamProbe[],
  control: CodexUpstreamControl,
  resolveThreadId: (probe: SessionUpstreamProbe) => Promise<string> = async (probe) =>
    probe.threadId,
): Promise<SessionUpstreamActivity[]> {
  return await control.withPinnedConnection(async (pinned) => {
    const activities: SessionUpstreamActivity[] = [];
    for (const probe of probes) {
      const fingerprint = upstreamConnectionFingerprint(probe);
      if (
        probe.upstreamKind !== "codex-app-server" ||
        !fingerprint ||
        fingerprint !== pinned.connectionFingerprint
      ) {
        continue;
      }
      try {
        const page = await pinned.listTurnPage({
          threadId: await resolveThreadId(probe),
          limit: CODEX_UPSTREAM_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "summary",
        });
        const activity = classifyCodexUpstreamTurns({ probe, turns: page.data });
        if (activity) {
          activities.push(activity);
        }
      } catch {
        // Stale links must not suppress healthy sessions in the same provider batch.
      }
    }
    return activities;
  });
}

export function createChecker(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  control: CodexSessionCatalogControl;
  getRuntimeConfig: () => OpenClawConfig | undefined;
}): NonNullable<SessionCatalogProvider["checkUpstreamActivity"]> {
  return async (probes) =>
    await checkCodexUpstreamActivity(probes, params.control, async (probe) => {
      const config = params.getRuntimeConfig();
      const entry = params.api.runtime.agent.session.getSessionEntry({
        agentId: probe.agentId,
        sessionKey: probe.sessionKey,
        readConsistency: "latest",
      });
      const sessionId = entry?.sessionId?.trim();
      if (!sessionId) {
        return probe.threadId;
      }
      const binding = await params.bindingStore.read(
        sessionBindingIdentity({ sessionId, sessionKey: probe.sessionKey, config }),
      );
      return binding?.connectionScope === "supervision" &&
        binding.supervisionSourceThreadId === probe.threadId
        ? binding.threadId
        : probe.threadId;
    });
}
