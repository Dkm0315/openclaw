/** Best-effort shared-state registry for adopted upstream sessions. */
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SessionUpstreamJsonValue, SessionUpstreamKind } from "../plugins/session-catalog.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

type SessionUpstreamDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "session_upstream_links" | "session_watch_cursors"
>;
type SessionUpstreamLinkRow = Selectable<OpenClawStateKyselyDatabase["session_upstream_links"]>;

export type SessionUpstreamLink = {
  sessionKey: string;
  agentId: string;
  catalogId: string;
  hostId: string;
  threadId: string;
  upstreamKind: SessionUpstreamKind;
  upstreamRef: SessionUpstreamJsonValue;
  marker: SessionUpstreamJsonValue | null;
  lastScannedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionUpstreamLinksByCatalog = Map<string, SessionUpstreamLink[]>;

const log = createSubsystemLogger("sessions/upstream-links");

function getSessionUpstreamKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SessionUpstreamDatabase>(db);
}

function parseJson(value: string | null): SessionUpstreamJsonValue | null {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as SessionUpstreamJsonValue;
  } catch {
    return null;
  }
}

function rowToSessionUpstreamLink(row: SessionUpstreamLinkRow): SessionUpstreamLink {
  return {
    sessionKey: row.session_key,
    agentId: row.agent_id,
    catalogId: row.catalog_id,
    hostId: row.host_id,
    threadId: row.thread_id,
    upstreamKind: row.upstream_kind as SessionUpstreamKind,
    upstreamRef: parseJson(row.upstream_ref_json),
    marker: parseJson(row.last_marker_json),
    ...(row.last_scanned_at === null
      ? {}
      : { lastScannedAt: normalizeSqliteNumber(row.last_scanned_at) ?? 0 }),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
}

export function upsertSessionUpstreamLink(
  input: {
    sessionKey: string;
    agentId: string;
    catalogId: string;
    hostId: string;
    threadId: string;
    upstreamKind: SessionUpstreamKind;
    upstreamRef: SessionUpstreamJsonValue;
    marker: SessionUpstreamJsonValue;
  },
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getSessionUpstreamKysely(db)
          .insertInto("session_upstream_links")
          .values({
            session_key: input.sessionKey,
            agent_id: input.agentId,
            catalog_id: input.catalogId,
            host_id: input.hostId,
            thread_id: input.threadId,
            upstream_kind: input.upstreamKind,
            upstream_ref_json: JSON.stringify(input.upstreamRef),
            last_marker_json: JSON.stringify(input.marker),
            last_scanned_at: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("session_key").doUpdateSet({
              agent_id: input.agentId,
              catalog_id: input.catalogId,
              host_id: input.hostId,
              thread_id: input.threadId,
              upstream_kind: input.upstreamKind,
              upstream_ref_json: JSON.stringify(input.upstreamRef),
              updated_at: now,
            }),
          ),
      );
    }, options);
  } catch (error) {
    log.warn(`failed to upsert session upstream link: ${String(error)}`);
  }
}

export function updateSessionUpstreamLinkMarker(
  sessionKey: string,
  marker: SessionUpstreamJsonValue,
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getSessionUpstreamKysely(db)
          .updateTable("session_upstream_links")
          .set({
            last_marker_json: JSON.stringify(marker),
            last_scanned_at: now,
            updated_at: now,
          })
          .where("session_key", "=", sessionKey),
      );
    }, options);
  } catch (error) {
    log.warn(`failed to update session upstream marker: ${String(error)}`);
  }
}

export function deleteSessionUpstreamLink(
  sessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getSessionUpstreamKysely(db)
          .deleteFrom("session_upstream_links")
          .where("session_key", "=", sessionKey),
      );
    }, options);
  } catch (error) {
    log.warn(`failed to delete session upstream link: ${String(error)}`);
  }
}

export function listWatchedSessionUpstreamLinks(
  options: OpenClawStateDatabaseOptions = {},
): SessionUpstreamLinksByCatalog {
  const grouped: SessionUpstreamLinksByCatalog = new Map();
  try {
    const { db } = openOpenClawStateDatabase(options);
    // Watch cursors own demand. Unwatched adopted sessions stay out of the polling hot path.
    const rows = executeSqliteQuerySync(
      db,
      getSessionUpstreamKysely(db)
        .selectFrom("session_upstream_links as links")
        .innerJoin(
          "session_watch_cursors as cursors",
          "cursors.target_session_key",
          "links.session_key",
        )
        .selectAll("links")
        .distinct()
        .orderBy("links.catalog_id", "asc")
        .orderBy("links.session_key", "asc"),
    ).rows;
    for (const row of rows) {
      const link = rowToSessionUpstreamLink(row);
      const catalogLinks = grouped.get(link.catalogId) ?? [];
      catalogLinks.push(link);
      grouped.set(link.catalogId, catalogLinks);
    }
  } catch (error) {
    log.warn(`failed to list watched session upstream links: ${String(error)}`);
  }
  return grouped;
}
