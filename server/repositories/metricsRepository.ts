import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import {
  hostMetrics, InsertHostMetric,
  trafficStats, InsertTrafficStat,
  forwardRules,
  hosts,
  tunnels,
  forwardTests, InsertForwardTest,
  tcpingStats, InsertTcpingStat,
  tunnelLatencyStats, InsertTunnelLatencyStat,
} from "../../drizzle/schema";
import { getDb, getSqlite, lastRowId, nowDate } from "../dbRuntime";
import { clampPositiveInt } from "./repositoryUtils";

// ==================== Host Metrics Queries ====================

export async function insertHostMetric(metric: InsertHostMetric) {
  const db = await getDb();
  if (!db) return;
  await db.insert(hostMetrics).values(metric);
}

export async function getLatestHostMetrics(hostId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(hostMetrics).where(eq(hostMetrics.hostId, hostId)).orderBy(desc(hostMetrics.recordedAt)).limit(limit);
}

// ==================== Traffic Stats Queries ====================

export async function insertTrafficStat(stat: InsertTrafficStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(trafficStats).values(stat);
}

export async function getTrafficStats(ruleId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(trafficStats).where(eq(trafficStats.ruleId, ruleId)).orderBy(desc(trafficStats.recordedAt)).limit(limit);
}

async function getRuleIdsByUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: forwardRules.id }).from(forwardRules).where(eq(forwardRules.userId, userId));
  return rows.map((r) => Number(r.id));
}

export async function getTotalTraffic(userId?: number) {
  const db = await getDb();
  if (!db) return { totalIn: 0, totalOut: 0 };

  if (userId) {
    const ruleIds = await getRuleIdsByUser(userId);
    if (ruleIds.length === 0) return { totalIn: 0, totalOut: 0 };
    const r = await db.select({
      totalIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      totalOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
    }).from(trafficStats)
      .where(sql`${trafficStats.ruleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)})`);
    const row = r[0];
    return {
      totalIn: Number(row?.totalIn) || 0,
      totalOut: Number(row?.totalOut) || 0,
    };
  }

  const r = await db.select({
    totalIn: sql<number>`COALESCE(SUM(bytesIn), 0)`,
    totalOut: sql<number>`COALESCE(SUM(bytesOut), 0)`,
  }).from(trafficStats);
  const row = r[0];
  return {
    totalIn: Number(row?.totalIn) || 0,
    totalOut: Number(row?.totalOut) || 0,
  };
}

/** 按规则汇总流量 */
export async function getTrafficSummaryByRule(opts: {
  userId?: number;
  hostId?: number;
  since?: Date;
} = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ ruleId: number; hostId: number; bytesIn: number; bytesOut: number; connections: number }>;
  const conds: any[] = [];
  if (opts.hostId) conds.push(eq(trafficStats.hostId, opts.hostId));
  if (opts.since) conds.push(gte(trafficStats.recordedAt, opts.since));
  const baseQuery = db
    .select({
      ruleId: trafficStats.ruleId,
      hostId: trafficStats.hostId,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
      connections: sql<number>`COALESCE(SUM(${trafficStats.connections}), 0)`,
    })
    .from(trafficStats);
  const rows = await (conds.length ? baseQuery.where(and(...conds)) : baseQuery).groupBy(trafficStats.ruleId, trafficStats.hostId);

  let result = rows.map((r) => ({
    ruleId: Number(r.ruleId),
    hostId: Number(r.hostId),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
    connections: Number(r.connections) || 0,
  }));

  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    const ok = new Set(ruleIds);
    result = result.filter((r) => ok.has(r.ruleId));
  }
  return result;
}

/** 按时间分桶聚合某条规则的流量序列 */
export async function getTrafficSeriesByRule(
  ruleId: number,
  opts: { bucketMinutes?: number; since?: Date } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; bytesIn: number; bytesOut: number; connections: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 60);
  const since = opts.since ?? new Date(Date.now() - 60 * 60 * 1000);
  const sinceSec = Math.floor(since.getTime() / 1000);
  const bucketSec = bucket * 60;

  const bucketExpr = sql.raw(`("recordedAt" / ${bucketSec}) * ${bucketSec}`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
      connections: sql<number>`COALESCE(SUM(${trafficStats.connections}), 0)`,
    })
    .from(trafficStats)
    .where(and(eq(trafficStats.ruleId, ruleId), gte(trafficStats.recordedAt, since)))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
    connections: Number(r.connections) || 0,
  })).filter((r) => r.bucket.getTime() / 1000 >= sinceSec);
}

/** 获取全局流量走势（按时间分桶，用于仪表盘） */
export async function getGlobalTrafficSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; bytesIn: number; bytesOut: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 5, 60);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;

  const conds: any[] = [gte(trafficStats.recordedAt, since)];
  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    if (ruleIds.length === 0) return [];
    conds.push(sql`${trafficStats.ruleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)})`);
  }

  const bucketExpr = sql.raw(`("recordedAt" / ${bucketSec}) * ${bucketSec}`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
    })
    .from(trafficStats)
    .where(and(...conds))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
  }));
}

// ==================== TCPing Stats ====================

export async function insertTcpingStat(stat: InsertTcpingStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(tcpingStats).values(stat);
}

export async function insertTcpingStats(stats: InsertTcpingStat[]) {
  const db = await getDb();
  if (!db) return;
  if (stats.length === 0) return;
  await db.insert(tcpingStats).values(stats);
}

/** 获取某条规则的 TCPing 延迟序列（按时间升序） */
export async function insertTunnelLatencyStat(stat: InsertTunnelLatencyStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(tunnelLatencyStats).values(stat);
  await db.update(tunnels).set({
    lastLatencyMs: stat.isTimeout ? null : (stat.latencyMs ?? null),
    lastTestStatus: stat.isTimeout ? "failed" : "success",
    lastTestAt: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(tunnels.id, stat.tunnelId));
}

export async function getTunnelLatencySeries(
  tunnelId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = opts.limit ?? 2880;
  return db
    .select({
      latencyMs: tunnelLatencyStats.latencyMs,
      isTimeout: tunnelLatencyStats.isTimeout,
      recordedAt: tunnelLatencyStats.recordedAt,
    })
    .from(tunnelLatencyStats)
    .where(and(eq(tunnelLatencyStats.tunnelId, tunnelId), gte(tunnelLatencyStats.recordedAt, since)))
    .orderBy(asc(tunnelLatencyStats.recordedAt))
    .limit(limit);
}
export async function getTcpingSeriesByRule(
  ruleId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = opts.limit ?? 2880; // 24h * 120 per hour max
  const rows = await db
    .select({
      latencyMs: tcpingStats.latencyMs,
      isTimeout: tcpingStats.isTimeout,
      recordedAt: tcpingStats.recordedAt,
    })
    .from(tcpingStats)
    .where(and(eq(tcpingStats.ruleId, ruleId), gte(tcpingStats.recordedAt, since)))
    .orderBy(asc(tcpingStats.recordedAt))
    .limit(limit);
  return rows;
}

/** 获取全局 TCPing 延迟序列（所有规则的平均延迟，按时间分桶） */
export async function getGlobalTcpingSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; avgLatency: number; maxLatency: number; minLatency: number; timeoutCount: number; totalCount: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 60);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;

  const conds: any[] = [gte(tcpingStats.recordedAt, since)];
  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    if (ruleIds.length === 0) return [];
    conds.push(sql`${tcpingStats.ruleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)})`);
  }

  const bucketExpr = sql.raw(`("recordedAt" / ${bucketSec}) * ${bucketSec}`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      avgLatency: sql<number>`COALESCE(AVG(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      maxLatency: sql<number>`COALESCE(MAX(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      minLatency: sql<number>`COALESCE(MIN(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      timeoutCount: sql<number>`SUM(CASE WHEN ${tcpingStats.isTimeout} = 1 THEN 1 ELSE 0 END)`,
      totalCount: sql<number>`COUNT(*)`,
    })
    .from(tcpingStats)
    .where(and(...conds))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    avgLatency: Math.round(Number(r.avgLatency) || 0),
    maxLatency: Number(r.maxLatency) || 0,
    minLatency: Number(r.minLatency) || 0,
    timeoutCount: Number(r.timeoutCount) || 0,
    totalCount: Number(r.totalCount) || 0,
  }));
}

/** 清理过期的 TCPing 数据（保留最近 N 小时） */
export async function cleanOldTcpingStats(retainHours: number = 48) {
  const db = await getDb();
  if (!db) return;
  const cutoff = new Date(Date.now() - retainHours * 3600 * 1000);
  const sqlite = getSqlite();
  if (!sqlite) return;
  const cutoffSec = Math.floor(cutoff.getTime() / 1000);
  sqlite.prepare(`DELETE FROM tcping_stats WHERE recordedAt < ?`).run(cutoffSec);
}

export async function timeoutStaleForwardTests(ttlSeconds: number = 60): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - ttlSeconds * 1000);
  const sqlite = getSqlite();
  // 用 SQL 直接 update，避免拉取后再写入的竞争
  if (!sqlite) return 0;
  const cutoffSec = Math.floor(cutoff.getTime() / 1000);
  const stmt = sqlite.prepare(
    `UPDATE forward_tests
     SET status = 'timeout',
         message = COALESCE(NULLIF(message, ''), '自测超时：Agent 未在' || ? || '秒内上报结果，请检查 Agent 是否在线或已升级到最新版本'),
         updatedAt = unixepoch()
     WHERE status IN ('pending', 'running')
       AND updatedAt < ?`
  );
  const info = stmt.run(ttlSeconds, cutoffSec);
  return info.changes || 0;
}
