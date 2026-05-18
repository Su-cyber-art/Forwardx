import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { ENV } from "./env";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

function resolveDbPath(): string {
  const p = ENV.sqlitePath || "/data/forwardx.db";
  const dir = path.dirname(p);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return p;
}

export async function getDb() {
  if (_db) return _db;
  try {
    const dbPath = resolveDbPath();
    _sqlite = new Database(dbPath);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("synchronous = NORMAL");
    _sqlite.pragma("foreign_keys = ON");
    _db = drizzle(_sqlite);
    console.log(`[Database] SQLite opened at ${dbPath}`);
  } catch (error) {
    console.error("[Database] Failed to open SQLite:", error);
    _db = null;
  }
  return _db;
}

export function getSqlite() {
  return _sqlite;
}

export function lastRowId(): number {
  const sqlite = getSqlite();
  if (!sqlite) return 0;
  const r = sqlite.prepare("SELECT last_insert_rowid() as id").get() as { id: number | bigint };
  return Number(r.id);
}

export const nowDate = () => new Date();
