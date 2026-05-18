import { eq } from "drizzle-orm";
import { systemSettings } from "../../drizzle/schema";
import { getDb, getSqlite } from "../dbRuntime";

// ==================== System Settings (key-value) ====================

/** 读取单个系统设置；不存在返回 null */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const r = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
  return r[0]?.value ?? null;
}

/** 批量读取所有系统设置 */
export async function getAllSettings(): Promise<Record<string, string | null>> {
  const db = await getDb();
  if (!db) return {};
  const rows = await db.select().from(systemSettings);
  const out: Record<string, string | null> = {};
  for (const r of rows) out[r.key] = r.value ?? null;
  return out;
}

/** UPSERT 单个系统设置 */
export async function setSetting(key: string, value: string | null): Promise<void> {
  const sqlite = getSqlite();
  if (!sqlite) return;
  // 直接使用 sqlite UPSERT，避免 drizzle 的 onConflict 写法版本差异
  sqlite.prepare(
    `INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=unixepoch()`
  ).run(key, value);
}

/** 批量 UPSERT */
export async function setSettings(map: Record<string, string | null>): Promise<void> {
  for (const [k, v] of Object.entries(map)) {
    await setSetting(k, v);
  }
}
