import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesignIRSchema, type AgentTask, type DesignIR, type Patch } from '@pwb/domain';
import * as schema from './schema.js';

export interface LocalDatabase { sqlite: Database.Database; orm: BetterSQLite3Database<typeof schema>; }
const migrationsPath = join(dirname(fileURLToPath(import.meta.url)), 'migrations', '0000_phase0.sql');
const fallbackMigration = `PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, parent_id TEXT, hash TEXT NOT NULL, ir TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, stage TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, base_version_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS patches (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, base_version_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL, stage TEXT NOT NULL, approver_role TEXT NOT NULL, version_id TEXT NOT NULL, version_hash TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, provenance TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);`;

export function openDatabase(filename: string): LocalDatabase {
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(existsSync(migrationsPath) ? readFileSync(migrationsPath, 'utf8') : fallbackMigration);
  return { sqlite, orm: drizzle(sqlite, { schema }) };
}

interface ProjectInput { id: string; name: string; }
interface VersionInput { id: string; projectId: string; parentId?: string; hash: string; ir: DesignIR; }
interface ApprovalInput { id: string; runId: string; projectId: string; stage: 'identity' | 'prototype' | 'finalization'; approverRole: 'captain'; versionId: string; versionHash: string; decision: 'approved' | 'rejected'; rationale: string; }
interface EventInput { id: string; runId: string; type: string; payload: Record<string, unknown>; }
interface RunInput { id: string; projectId: string; state: string; }

export class ProjectRepository {
  private writer = Promise.resolve();
  constructor(private readonly db: LocalDatabase) {}

  private write<T>(operation: () => T): Promise<T> { const next = this.writer.then(operation); this.writer = next.then(() => undefined, () => undefined); return next; }
  async createProject(input: ProjectInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.projects).values({ ...input, createdAt: new Date().toISOString() }).run(); }); }
  async createRun(input: RunInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.runs).values({ ...input, createdAt: new Date().toISOString() }).run(); }); }
  async saveTask(task: AgentTask, runId: string): Promise<void> { await this.write(() => { this.db.orm.insert(schema.tasks).values({ id: task.id, runId, stage: task.stage, role: task.role, state: task.state, baseVersionId: task.baseVersionId, payload: JSON.stringify(task) }).run(); }); }
  async savePatch(patch: Patch, runId: string): Promise<void> { await this.write(() => { this.db.orm.insert(schema.patches).values({ id: patch.idempotencyKey ?? `${runId}-${patch.baseVersionId}`, runId, baseVersionId: patch.baseVersionId, payload: JSON.stringify(patch), createdAt: new Date().toISOString() }).run(); }); }
  async saveVersion(input: VersionInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.versions).values({ id: input.id, projectId: input.projectId, parentId: input.parentId ?? null, hash: input.hash, ir: JSON.stringify(DesignIRSchema.parse(input.ir)), createdAt: new Date().toISOString() }).run(); }); }
  async getVersion(id: string): Promise<{ id: string; projectId: string; parentId: string | null; hash: string; ir: DesignIR } | undefined> { const row = this.db.sqlite.prepare('SELECT id, project_id as projectId, parent_id as parentId, hash, ir FROM versions WHERE id = ?').get(id) as { id: string; projectId: string; parentId: string | null; hash: string; ir: string } | undefined; return row ? { ...row, ir: DesignIRSchema.parse(JSON.parse(row.ir)) } : undefined; }
  async createApproval(input: ApprovalInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.approvals).values({ ...input, createdAt: new Date().toISOString(), valid: 1 }).run(); }); }
  async invalidateApprovalsForVersion(projectId: string, versionId: string): Promise<void> { await this.write(() => { this.db.sqlite.prepare('UPDATE approvals SET valid = 0 WHERE project_id = ? AND version_id = ?').run(projectId, versionId); }); }
  async listApprovals(projectId: string): Promise<Array<{ id: string; valid: boolean }>> { return this.db.sqlite.prepare('SELECT id, valid FROM approvals WHERE project_id = ? ORDER BY rowid').all(projectId).map((row) => ({ id: String((row as { id: string }).id), valid: Boolean((row as { valid: number }).valid) })); }
  async appendEvent(input: EventInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.events).values({ id: input.id, runId: input.runId, type: input.type, payload: JSON.stringify(input.payload), createdAt: new Date().toISOString() }).run(); }); }
  async listEvents(runId: string): Promise<Array<{ id: string; type: string; payload: Record<string, unknown> }>> { return this.db.sqlite.prepare('SELECT id, type, payload FROM events WHERE run_id = ? ORDER BY rowid').all(runId).map((row) => { const item = row as { id: string; type: string; payload: string }; return { id: item.id, type: item.type, payload: JSON.parse(item.payload) as Record<string, unknown> }; }); }
  dump(): string { return JSON.stringify(this.db.sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all()); }
}

export function scanSecrets(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [['password', /["']?password["']?\s*[:=]/i], ['token', /(?:^|["'\s])token(?:["']?\s*[:=])/i], ['secret', /["']?secret["']?\s*[:=]/i], ['api_key', /["']?api[_-]?key["']?\s*[:=]/i], ['private_key', /["']?private[_-]?key["']?\s*[:=]/i], ['oauth', /["']?oauth[_-]?token["']?\s*[:=]/i]];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
