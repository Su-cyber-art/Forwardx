import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  forwardRules,
  paymentOrders, InsertPaymentOrder,
  subscriptionPlans, InsertSubscriptionPlan,
  subscriptionPlanHosts,
  subscriptionPlanTunnels,
  userSubscriptions, InsertUserSubscription,
  users,
} from "../../drizzle/schema";
import { getDb, getSqlite, lastRowId, nowDate } from "../dbRuntime";
import { getHostById } from "./hostRepository";
import { getTunnelById } from "./tunnelRepository";
import { getUserById, resetUserTraffic, updateUserTrafficSettings } from "./userRepository";
import { addMonthsClamped, nextMonthlyTrafficReset } from "./repositoryUtils";

// ==================== Payment Orders ====================

export async function createPaymentOrder(order: InsertPaymentOrder) {
  const db = await getDb();
  if (!db) return undefined;
  await db.insert(paymentOrders).values(order);
  return getPaymentOrderByOutTradeNo(order.outTradeNo);
}

export async function getPaymentOrderByOutTradeNo(outTradeNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(paymentOrders).where(eq(paymentOrders.outTradeNo, outTradeNo)).limit(1);
  return r[0];
}

// ==================== Subscription Plans ====================

async function getPlanHostIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ hostId: subscriptionPlanHosts.hostId }).from(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, planId));
  return rows.map(r => r.hostId);
}

async function getPlanTunnelIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: subscriptionPlanTunnels.tunnelId }).from(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, planId));
  return rows.map(r => r.tunnelId);
}

async function attachPlanResources<T extends { id: number }>(plans: T[]) {
  return Promise.all(plans.map(async (plan) => ({
    ...plan,
    hostIds: await getPlanHostIds(plan.id),
    tunnelIds: await getPlanTunnelIds(plan.id),
  })));
}

export async function listSubscriptionPlans(includeHidden = true) {
  const db = await getDb();
  if (!db) return [];
  const rows = includeHidden
    ? await db.select().from(subscriptionPlans).orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt))
    : await db.select().from(subscriptionPlans).where(and(eq(subscriptionPlans.isActive, true), eq(subscriptionPlans.isStoreVisible, true))).orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt));
  return attachPlanResources(rows);
}

export async function getSubscriptionPlanById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).limit(1);
  if (!rows[0]) return undefined;
  return (await attachPlanResources([rows[0]]))[0];
}

export async function createSubscriptionPlan(data: InsertSubscriptionPlan, hostIds: number[], tunnelIds: number[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(subscriptionPlans).values(data);
  const id = lastRowId();
  await setSubscriptionPlanResources(id, hostIds, tunnelIds);
  return getSubscriptionPlanById(id);
}

export async function updateSubscriptionPlan(id: number, data: Partial<InsertSubscriptionPlan>, hostIds?: number[], tunnelIds?: number[]) {
  const db = await getDb();
  if (!db) return undefined;
  await db.update(subscriptionPlans).set({ ...data, updatedAt: nowDate() } as any).where(eq(subscriptionPlans.id, id));
  if (hostIds || tunnelIds) {
    await setSubscriptionPlanResources(id, hostIds ?? await getPlanHostIds(id), tunnelIds ?? await getPlanTunnelIds(id));
  }
  return getSubscriptionPlanById(id);
}

export async function deleteSubscriptionPlan(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, id));
  await db.delete(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, id));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, id));
}

export async function setSubscriptionPlanResources(planId: number, hostIds: number[], tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, planId));
  await db.delete(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, planId));
  const uniqueHostIds = Array.from(new Set(hostIds.filter(id => id > 0)));
  const uniqueTunnelIds = Array.from(new Set(tunnelIds.filter(id => id > 0)));
  if (uniqueHostIds.length > 0) await db.insert(subscriptionPlanHosts).values(uniqueHostIds.map(hostId => ({ planId, hostId })));
  if (uniqueTunnelIds.length > 0) await db.insert(subscriptionPlanTunnels).values(uniqueTunnelIds.map(tunnelId => ({ planId, tunnelId })));
}

export async function listUserSubscriptions(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const base = db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      username: users.username,
      name: users.name,
      planId: userSubscriptions.planId,
      planName: subscriptionPlans.name,
      priceCents: subscriptionPlans.priceCents,
      durationDays: subscriptionPlans.durationDays,
      portCount: subscriptionPlans.portCount,
      status: userSubscriptions.status,
      source: userSubscriptions.source,
      paymentOrderNo: userSubscriptions.paymentOrderNo,
      portRangeStart: userSubscriptions.portRangeStart,
      portRangeEnd: userSubscriptions.portRangeEnd,
      nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
      startedAt: userSubscriptions.startedAt,
      expiresAt: userSubscriptions.expiresAt,
      createdAt: userSubscriptions.createdAt,
      updatedAt: userSubscriptions.updatedAt,
    })
    .from(userSubscriptions)
    .leftJoin(users, eq(userSubscriptions.userId, users.id))
    .leftJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id));
  if (userId !== undefined) return base.where(eq(userSubscriptions.userId, userId)).orderBy(desc(userSubscriptions.createdAt));
  return base.orderBy(desc(userSubscriptions.createdAt));
}

export async function getActiveUserSubscriptions(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const now = Math.floor(Date.now() / 1000);
  const conds: any[] = [
    eq(userSubscriptions.status, "active"),
    sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${now})`,
  ];
  if (userId !== undefined) conds.push(eq(userSubscriptions.userId, userId));
  const rows = await db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      planId: userSubscriptions.planId,
      status: userSubscriptions.status,
      source: userSubscriptions.source,
      paymentOrderNo: userSubscriptions.paymentOrderNo,
      portRangeStart: userSubscriptions.portRangeStart,
      portRangeEnd: userSubscriptions.portRangeEnd,
      nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
      startedAt: userSubscriptions.startedAt,
      expiresAt: userSubscriptions.expiresAt,
      planName: subscriptionPlans.name,
      portCount: subscriptionPlans.portCount,
      trafficLimit: subscriptionPlans.trafficLimit,
      rateLimitMbps: subscriptionPlans.rateLimitMbps,
      maxRules: subscriptionPlans.maxRules,
      maxConnections: subscriptionPlans.maxConnections,
      maxIPs: subscriptionPlans.maxIPs,
    })
    .from(userSubscriptions)
    .leftJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(and(...conds))
    .orderBy(desc(userSubscriptions.createdAt));
  return Promise.all(rows.map(async (row) => ({
    ...row,
    hostIds: await getPlanHostIds(row.planId),
    tunnelIds: await getPlanTunnelIds(row.planId),
  })));
}

export async function createUserSubscription(data: InsertUserSubscription) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(userSubscriptions).values(data);
  return lastRowId();
}

export async function updateUserSubscription(id: number, data: Partial<InsertUserSubscription>) {
  const db = await getDb();
  if (!db) return;
  await db.update(userSubscriptions).set({ ...data, updatedAt: nowDate() } as any).where(eq(userSubscriptions.id, id));
}

export async function cancelUserSubscription(id: number) {
  return updateUserSubscription(id, { status: "cancelled" } as any);
}

export async function expireUserSubscriptions() {
  const sqlite = getSqlite();
  if (!sqlite) return 0;
  const now = Math.floor(Date.now() / 1000);
  const result = sqlite.prepare(`UPDATE user_subscriptions SET status='expired', updatedAt=? WHERE status='active' AND expiresAt IS NOT NULL AND expiresAt <= ?`).run(now, now);
  return Number(result.changes || 0);
}

export async function rechargeSubscriptionTrafficCycles() {
  const db = await getDb();
  if (!db) return 0;
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const due = await db.select().from(userSubscriptions).where(and(
    eq(userSubscriptions.status, "active"),
    sql`${userSubscriptions.nextTrafficResetAt} IS NOT NULL`,
    sql`${userSubscriptions.nextTrafficResetAt} <= ${nowSec}`,
    sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
  ));
  const resetUserIds = new Set<number>();
  for (const sub of due as any[]) {
    const expiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
    let next = sub.nextTrafficResetAt ? new Date(sub.nextTrafficResetAt) : null;
    if (!next) continue;
    while (next && next.getTime() <= now.getTime()) {
      next = addMonthsClamped(next, 1);
    }
    const boundedNext = next && (!expiresAt || next.getTime() < expiresAt.getTime()) ? next : null;
    await updateUserSubscription(sub.id, {
      nextTrafficResetAt: boundedNext,
      lastTrafficResetAt: now,
    } as any);
    resetUserIds.add(Number(sub.userId));
  }
  for (const userId of resetUserIds) {
    await resetUserTraffic(userId);
  }
  return resetUserIds.size;
}

export async function getUserPlanPortRange(userId: number, hostId?: number, tunnelId?: number): Promise<{ start: number; end: number } | null> {
  const active = await getActiveUserSubscriptions(userId);
  for (const sub of active as any[]) {
    if (!sub.portRangeStart || !sub.portRangeEnd) continue;
    if (tunnelId && Array.isArray(sub.tunnelIds) && sub.tunnelIds.includes(tunnelId)) return { start: sub.portRangeStart, end: sub.portRangeEnd };
    if (!tunnelId && hostId && Array.isArray(sub.hostIds) && sub.hostIds.includes(hostId)) return { start: sub.portRangeStart, end: sub.portRangeEnd };
    if (hostId && Array.isArray(sub.hostIds) && sub.hostIds.includes(hostId)) return { start: sub.portRangeStart, end: sub.portRangeEnd };
  }
  return null;
}

export async function findAvailableSubscriptionPortBlock(portCount: number, hostIds: number[], tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return null;
  const count = Math.max(1, portCount);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const hostId of hostIds) {
    const host = await getHostById(hostId);
    if (!host) continue;
    const start = Number((host as any).portRangeStart || 10000);
    const end = Number((host as any).portRangeEnd || 65535);
    ranges.push({ start, end });
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId);
    if (!tunnel) continue;
    const start = Number((tunnel as any).portRangeStart || 10000);
    const end = Number((tunnel as any).portRangeEnd || 65535);
    ranges.push({ start, end });
  }
  const start = ranges.length ? Math.max(...ranges.map(r => r.start)) : 10000;
  const end = ranges.length ? Math.min(...ranges.map(r => r.end)) : 65535;
  if (start <= 0 || end < start || end - start + 1 < count) return null;

  const used = new Set<number>();
  const ruleRows = await db.select({ port: forwardRules.sourcePort }).from(forwardRules);
  ruleRows.forEach(row => used.add(Number(row.port)));
  const subRows = await db.select({
    portRangeStart: userSubscriptions.portRangeStart,
    portRangeEnd: userSubscriptions.portRangeEnd,
  }).from(userSubscriptions).where(eq(userSubscriptions.status, "active"));
  subRows.forEach(row => {
    const s = Number(row.portRangeStart || 0);
    const e = Number(row.portRangeEnd || 0);
    for (let p = s; p > 0 && p <= e; p++) used.add(p);
  });

  for (let port = start; port <= end - count + 1; port++) {
    let ok = true;
    for (let p = port; p < port + count; p++) {
      if (used.has(p)) {
        ok = false;
        port = p;
        break;
      }
    }
    if (ok) return { start: port, end: port + count - 1 };
  }
  return null;
}

export async function applySubscriptionToUser(userId: number, planId: number, source: "admin" | "payment", paymentOrderNo?: string | null, startsAt?: Date) {
  const plan = await getSubscriptionPlanById(planId);
  if (!plan) throw new Error("套餐不存在");
  if (!plan.isActive) throw new Error("套餐已停用");
  const hostIds = (plan as any).hostIds || [];
  const tunnelIds = (plan as any).tunnelIds || [];
  if (hostIds.length === 0 && tunnelIds.length === 0) throw new Error("套餐未绑定任何主机或隧道");
  const block = await findAvailableSubscriptionPortBlock(Number(plan.portCount) || 1, hostIds, tunnelIds);
  if (!block) throw new Error("套餐可用端口不足，无法分配连续端口段");
  const now = startsAt || new Date();
  const expiresAt = Number(plan.durationDays) > 0 ? new Date(now.getTime() + Number(plan.durationDays) * 24 * 3600 * 1000) : null;
  const nextTrafficResetAt = Number(plan.trafficLimit || 0) > 0 ? nextMonthlyTrafficReset(now, expiresAt) : null;
  const subscriptionId = await createUserSubscription({
    userId,
    planId,
    status: "active",
    source,
    paymentOrderNo: paymentOrderNo ?? null,
    portRangeStart: block.start,
    portRangeEnd: block.end,
    nextTrafficResetAt,
    startedAt: now,
    expiresAt,
  } as any);
  const user = await getUserById(userId);
  await updateUserTrafficSettings(userId, {
    canAddRules: true,
    allowForwardXTunnel: true,
    maxPorts: Math.max(Number(user?.maxPorts || 0), Number(plan.portCount || 0)),
    maxRules: Math.max(Number(user?.maxRules || 0), Number(plan.maxRules || 0)),
    maxConnections: Math.max(Number((user as any)?.maxConnections || 0), Number((plan as any).maxConnections || 0)),
    maxIPs: Math.max(Number((user as any)?.maxIPs || 0), Number((plan as any).maxIPs || 0)),
    trafficLimit: Math.max(Number(user?.trafficLimit || 0), Number(plan.trafficLimit || 0)),
    gostRateLimitIn: Number(plan.rateLimitMbps || 0) > 0 ? Number(plan.rateLimitMbps) : Number(user?.gostRateLimitIn || 0),
    gostRateLimitOut: Number(plan.rateLimitMbps || 0) > 0 ? Number(plan.rateLimitMbps) : Number(user?.gostRateLimitOut || 0),
    expiresAt: expiresAt && (!user?.expiresAt || new Date(user.expiresAt).getTime() < expiresAt.getTime()) ? expiresAt : user?.expiresAt ?? null,
  });
  return { subscriptionId, portRangeStart: block.start, portRangeEnd: block.end, expiresAt };
}

export async function listPaymentOrders(limit = 100, userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const base = db
    .select({
      id: paymentOrders.id,
      outTradeNo: paymentOrders.outTradeNo,
      userId: paymentOrders.userId,
      username: users.username,
      name: users.name,
      provider: paymentOrders.provider,
      paymentType: paymentOrders.paymentType,
      status: paymentOrders.status,
      subject: paymentOrders.subject,
      amountCents: paymentOrders.amountCents,
      currency: paymentOrders.currency,
      tradeNo: paymentOrders.tradeNo,
      payUrl: paymentOrders.payUrl,
      qrCode: paymentOrders.qrCode,
      planId: paymentOrders.planId,
      subscriptionId: paymentOrders.subscriptionId,
      expiresAt: paymentOrders.expiresAt,
      paidAt: paymentOrders.paidAt,
      createdAt: paymentOrders.createdAt,
      updatedAt: paymentOrders.updatedAt,
    })
    .from(paymentOrders)
    .leftJoin(users, eq(paymentOrders.userId, users.id));
  if (userId !== undefined) {
    return base.where(eq(paymentOrders.userId, userId)).orderBy(desc(paymentOrders.createdAt)).limit(limit);
  }
  return base.orderBy(desc(paymentOrders.createdAt)).limit(limit);
}

export async function updatePaymentOrder(outTradeNo: string, data: Partial<InsertPaymentOrder>) {
  const db = await getDb();
  if (!db) return undefined;
  await db
    .update(paymentOrders)
    .set({ ...data, updatedAt: nowDate() } as Partial<InsertPaymentOrder>)
    .where(eq(paymentOrders.outTradeNo, outTradeNo));
  return getPaymentOrderByOutTradeNo(outTradeNo);
}

export async function markPaymentOrderPaid(outTradeNo: string, data: { tradeNo?: string | null; rawNotify?: string | null; amountCents?: number; currency?: string }) {
  const existing = await getPaymentOrderByOutTradeNo(outTradeNo);
  if (!existing) return undefined;
  if (existing.status === "paid" || existing.status === "completed") {
    return updatePaymentOrder(outTradeNo, {
      tradeNo: data.tradeNo || existing.tradeNo,
      rawNotify: data.rawNotify || existing.rawNotify,
    } as Partial<InsertPaymentOrder>);
  }
  return updatePaymentOrder(outTradeNo, {
    status: "paid",
    tradeNo: data.tradeNo || existing.tradeNo,
    rawNotify: data.rawNotify || existing.rawNotify,
    amountCents: data.amountCents || existing.amountCents,
    currency: data.currency || existing.currency,
    paidAt: nowDate(),
  } as Partial<InsertPaymentOrder>);
}

export async function getPaymentOrderStats() {
  const sqlite = getSqlite();
  if (!sqlite) {
    return { totalOrders: 0, pendingOrders: 0, paidOrders: 0, paidAmountCents: 0 };
  }
  const totalOrders = (sqlite.prepare(`SELECT COUNT(*) AS n FROM payment_orders`).get() as any)?.n || 0;
  const pendingOrders = (sqlite.prepare(`SELECT COUNT(*) AS n FROM payment_orders WHERE status = 'pending'`).get() as any)?.n || 0;
  const paid = sqlite.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amountCents), 0) AS amount FROM payment_orders WHERE status IN ('paid', 'completed')`).get() as any;
  return {
    totalOrders: Number(totalOrders),
    pendingOrders: Number(pendingOrders),
    paidOrders: Number(paid?.n || 0),
    paidAmountCents: Number(paid?.amount || 0),
  };
}
