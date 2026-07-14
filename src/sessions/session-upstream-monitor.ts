/** Polls watched adopted sessions for direct upstream human activity. */
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import type {
  SessionCatalogProvider,
  SessionUpstreamActivity,
  SessionUpstreamProbe,
} from "../plugins/session-catalog.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { recordSessionHumanDirectMessage } from "./session-state-events.js";
import {
  listWatchedSessionUpstreamLinks,
  updateSessionUpstreamLinkMarker,
} from "./session-upstream-links.js";

export const SESSION_UPSTREAM_MONITOR_INTERVAL_MS = 60_000;
const SESSION_UPSTREAM_MONITOR_INITIAL_DELAY_MS = 15_000;
const SESSION_UPSTREAM_SELF_ECHO_WINDOW_MS = 15_000;

const log = createSubsystemLogger("sessions/upstream-monitor");

type SessionUpstreamMonitorOptions = OpenClawStateDatabaseOptions & {
  providers?: readonly SessionCatalogProvider[];
  now?: () => number;
  loadEntry?: typeof loadSessionEntry;
  isRunActive?: typeof isEmbeddedAgentRunActive;
};

export type SessionUpstreamMonitor = { stop: () => void };

function currentProviders(): SessionCatalogProvider[] {
  return (getPluginRegistryState()?.activeRegistry?.sessionCatalogs ?? []).map(
    (registration) => registration.provider,
  );
}

function databaseOptions(options: SessionUpstreamMonitorOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.path ? { path: options.path } : {}),
  };
}

function isSelfEcho(
  probe: SessionUpstreamProbe,
  activity: SessionUpstreamActivity,
  options: SessionUpstreamMonitorOptions,
): boolean {
  const entry = (options.loadEntry ?? loadSessionEntry)({
    sessionKey: probe.sessionKey,
    agentId: probe.agentId,
    clone: false,
    ...(options.env ? { env: options.env } : {}),
  });
  if (entry?.sessionId && (options.isRunActive ?? isEmbeddedAgentRunActive)(entry.sessionId)) {
    return true;
  }
  // OpenClaw's own upstream turn updates local activity nearly simultaneously.
  // Consume that upstream marker or the next cadence would misreport it as external.
  return [entry?.lastInteractionAt, entry?.lastActivityAt].some(
    (timestamp) =>
      typeof timestamp === "number" &&
      Math.abs(timestamp - activity.occurredAt) <= SESSION_UPSTREAM_SELF_ECHO_WINDOW_MS,
  );
}

export async function runSessionUpstreamMonitorTick(
  options: SessionUpstreamMonitorOptions = {},
): Promise<void> {
  const dbOptions = databaseOptions(options);
  const linksByCatalog = listWatchedSessionUpstreamLinks(dbOptions);
  const providers = options.providers ?? currentProviders();
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const [catalogId, links] of linksByCatalog) {
    const provider = providerById.get(catalogId);
    if (!provider?.checkUpstreamActivity) {
      continue;
    }
    const probes = links.map(
      (link): SessionUpstreamProbe => ({
        sessionKey: link.sessionKey,
        agentId: link.agentId,
        threadId: link.threadId,
        hostId: link.hostId,
        upstreamKind: link.upstreamKind,
        upstreamRef: link.upstreamRef,
        marker: link.marker,
      }),
    );
    const probeBySessionKey = new Map(probes.map((probe) => [probe.sessionKey, probe]));
    try {
      const activities = await provider.checkUpstreamActivity(probes);
      for (const activity of activities) {
        const probe = probeBySessionKey.get(activity.sessionKey);
        if (
          !probe ||
          activity.humanTurns < 1 ||
          !Number.isFinite(activity.occurredAt) ||
          !activity.dedupeToken
        ) {
          continue;
        }
        if (isSelfEcho(probe, activity, options)) {
          updateSessionUpstreamLinkMarker(probe.sessionKey, activity.nextMarker, {
            ...dbOptions,
            now: (options.now ?? Date.now)(),
          });
          continue;
        }
        const recorded = recordSessionHumanDirectMessage(
          {
            sessionKey: probe.sessionKey,
            agentId: probe.agentId,
            actor: { actorType: "human" },
            channel: catalogId,
            dedupeKey: `upstream:${probe.sessionKey}:${activity.dedupeToken}`,
            occurredAt: activity.occurredAt,
          },
          dbOptions,
        );
        if (!recorded) {
          continue;
        }
        // Commit the scan marker only after the durable event insert/dedupe succeeds.
        updateSessionUpstreamLinkMarker(probe.sessionKey, activity.nextMarker, {
          ...dbOptions,
          now: (options.now ?? Date.now)(),
        });
      }
    } catch (error) {
      log.warn(`upstream activity probe failed for ${catalogId}: ${String(error)}`);
    }
  }
}

export function startSessionUpstreamMonitor(
  options: SessionUpstreamMonitorOptions = {},
): SessionUpstreamMonitor {
  let stopped = false;
  let running = false;
  const run = () => {
    if (stopped || running) {
      return;
    }
    running = true;
    void runSessionUpstreamMonitorTick(options).finally(() => {
      running = false;
    });
  };
  // Session catalogs own this bounded freshness exception; plugin metadata remains restart-stable.
  const initialTimer = setTimeout(run, SESSION_UPSTREAM_MONITOR_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const interval = setInterval(run, SESSION_UPSTREAM_MONITOR_INTERVAL_MS);
  interval.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
    },
  };
}
