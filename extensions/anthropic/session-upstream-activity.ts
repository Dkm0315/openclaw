import fs from "node:fs/promises";
import {
  classifyClaudeCliHistoryMessage,
  classifyClaudeCliHistoryLine,
  type SessionCatalogContinueProviderResult,
  type SessionUpstreamActivity,
  type SessionUpstreamProbe,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";

const MAX_CLAUDE_UPSTREAM_TAIL_BYTES = 256 * 1024;
export const continueOperations = new Map<string, Promise<{ sessionKey: string }>>();

export async function link(
  sessionKey: string,
  hostId: string,
  threadId: string,
  listSessions: () => Promise<Array<{ threadId: string; filePath: string }>>,
): Promise<SessionCatalogContinueProviderResult> {
  if (hostId !== "gateway:local") {
    return { sessionKey };
  }
  try {
    const record = (await listSessions()).find((candidate) => candidate.threadId === threadId);
    const stat = record ? await fs.stat(record.filePath).catch(() => undefined) : undefined;
    return record && stat?.isFile()
      ? {
          sessionKey,
          upstream: {
            kind: "claude-cli",
            ref: { filePath: record.filePath },
            marker: { size: stat.size },
          },
        }
      : { sessionKey };
  } catch {
    // Liveness metadata is optional; continuation success must survive baseline failure.
    return { sessionKey };
  }
}

export function linkRemote(
  sessionKey: string,
  nodeId: string,
  threadId: string,
  markerUuid: string | null,
): SessionCatalogContinueProviderResult {
  return {
    sessionKey,
    upstream: {
      kind: "claude-cli",
      ref: { nodeId, threadId },
      marker: { uuid: markerUuid },
    },
  };
}

export async function linkContinued(params: {
  sessionKey: string;
  hostId: string;
  threadId: string;
  history?: ClaudeTranscriptItem[];
  listLocalSessions: () => Promise<Array<{ threadId: string; filePath: string }>>;
  readRemote: () => Promise<ClaudeTranscriptItem[]>;
}): Promise<SessionCatalogContinueProviderResult> {
  if (params.hostId === "gateway:local") {
    return await link(params.sessionKey, params.hostId, params.threadId, params.listLocalSessions);
  }
  if (!params.hostId.startsWith("node:")) {
    return { sessionKey: params.sessionKey };
  }
  try {
    const items = params.history ?? (await params.readRemote());
    return linkRemote(
      params.sessionKey,
      params.hostId.slice("node:".length),
      params.threadId,
      items[0]?.uuid ?? null,
    );
  } catch {
    return { sessionKey: params.sessionKey };
  }
}

function readFilePath(probe: SessionUpstreamProbe): string | undefined {
  return isRecord(probe.upstreamRef) && typeof probe.upstreamRef.filePath === "string"
    ? probe.upstreamRef.filePath
    : undefined;
}

function readMarkerSize(probe: SessionUpstreamProbe): number | undefined {
  if (!isRecord(probe.marker) || !Number.isSafeInteger(probe.marker.size)) {
    return undefined;
  }
  const size = probe.marker.size as number;
  return size >= 0 ? size : undefined;
}

export async function checkClaudeSessionUpstreamActivity(
  probe: SessionUpstreamProbe,
): Promise<SessionUpstreamActivity | undefined> {
  if (probe.upstreamKind !== "claude-cli") {
    return undefined;
  }
  const filePath = readFilePath(probe);
  const markerSize = readMarkerSize(probe);
  if (!filePath || markerSize === undefined) {
    return undefined;
  }
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= markerSize) {
      return undefined;
    }
    const start = Math.max(markerSize, stat.size - MAX_CLAUDE_UPSTREAM_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const tail = buffer.subarray(0, bytesRead);
    const lastNewline = tail.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return undefined;
    }
    const completeTail = tail.subarray(0, lastNewline + 1);
    const boundedTail =
      start > markerSize
        ? completeTail.subarray(Math.max(0, completeTail.indexOf(0x0a) + 1))
        : completeTail;
    let humanTurns = 0;
    let occurredAt: number | undefined;
    for (const [lineIndex, line] of boundedTail.toString("utf8").split(/\r?\n/).entries()) {
      if (!line.trim()) {
        continue;
      }
      const classification = classifyClaudeCliHistoryLine({
        line,
        cliSessionId: probe.threadId,
        sourceLineNumber: lineIndex + 1,
      });
      if (!classification.humanTurn) {
        continue;
      }
      humanTurns += 1;
      occurredAt = Math.max(occurredAt ?? 0, classification.occurredAt ?? stat.mtimeMs);
    }
    if (humanTurns === 0) {
      return undefined;
    }
    const nextSize = start + lastNewline + 1;
    return {
      sessionKey: probe.sessionKey,
      occurredAt: occurredAt ?? stat.mtimeMs,
      humanTurns,
      nextMarker: { size: nextSize },
      dedupeToken: String(nextSize),
    };
  } finally {
    await handle.close();
  }
}

function readMarkerUuid(probe: SessionUpstreamProbe): string | null | undefined {
  if (!isRecord(probe.marker)) {
    return undefined;
  }
  return probe.marker.uuid === null || typeof probe.marker.uuid === "string"
    ? probe.marker.uuid
    : undefined;
}

async function checkRemoteClaudeSessionUpstreamActivity(
  probe: SessionUpstreamProbe,
  readRemote: (probe: SessionUpstreamProbe) => Promise<ClaudeTranscriptItem[]>,
): Promise<SessionUpstreamActivity | undefined> {
  if (
    !isRecord(probe.upstreamRef) ||
    typeof probe.upstreamRef.nodeId !== "string" ||
    probe.hostId !== `node:${probe.upstreamRef.nodeId}`
  ) {
    return undefined;
  }
  const markerUuid = readMarkerUuid(probe);
  if (markerUuid === undefined) {
    return undefined;
  }
  const items = await readRemote(probe);
  const markerIndex =
    markerUuid === null ? -1 : items.findIndex((item) => item.uuid === markerUuid);
  const newItems = markerIndex < 0 ? items : items.slice(0, markerIndex);
  const newest = newItems[0];
  if (!newest?.uuid) {
    return undefined;
  }
  let humanTurns = 0;
  let occurredAt: number | undefined;
  for (const [itemIndex, item] of newItems.entries()) {
    if (item.type !== "userMessage") {
      continue;
    }
    const classification = classifyClaudeCliHistoryMessage({
      content: item.content ?? item.text,
      timestamp: item.timestamp,
      cliSessionId: probe.threadId,
      sourceLineNumber: itemIndex + 1,
    });
    if (!classification.humanTurn) {
      continue;
    }
    humanTurns += 1;
    occurredAt = Math.max(occurredAt ?? 0, classification.occurredAt ?? Date.now());
  }
  if (humanTurns === 0) {
    return undefined;
  }
  const activityId = newest.uuid;
  return {
    sessionKey: probe.sessionKey,
    occurredAt: occurredAt ?? Date.now(),
    humanTurns,
    nextMarker: { uuid: activityId },
    dedupeToken: activityId,
  };
}

export async function checkClaudeUpstreamActivity(
  probes: SessionUpstreamProbe[],
  readRemote?: (probe: SessionUpstreamProbe) => Promise<ClaudeTranscriptItem[]>,
): Promise<SessionUpstreamActivity[]> {
  const activities: SessionUpstreamActivity[] = [];
  for (const probe of probes) {
    try {
      const activity = readFilePath(probe)
        ? await checkClaudeSessionUpstreamActivity(probe)
        : readRemote
          ? await checkRemoteClaudeSessionUpstreamActivity(probe, readRemote)
          : undefined;
      if (activity) {
        activities.push(activity);
      }
    } catch {
      // One missing transcript must not suppress healthy sessions in the provider batch.
    }
  }
  return activities;
}
