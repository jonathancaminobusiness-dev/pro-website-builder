import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { designIRSchema, hashJson, type AgentTask, type Approval, type DesignIR, type Patch } from '@pwb/domain';
import * as schema from './schema.js';

export interface LocalDatabase { sqlite: Database.Database; orm: BetterSQLite3Database<typeof schema>; }
const migration = `PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, parent_id TEXT, hash TEXT NOT NULL, ir TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT NOT NULL, run_id TEXT NOT NULL, attempt INTEGER NOT NULL, stage TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, base_version_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, id, attempt));
CREATE TABLE IF NOT EXISTS patches (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, base_version_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL, stage TEXT NOT NULL, approver_role TEXT NOT NULL, version_id TEXT NOT NULL, version_hash TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);`;

const SCHEMA_VERSION = 2;

export function openDatabase(filename: string): LocalDatabase {
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const [version] = sqlite.pragma('user_version') as Array<{ user_version: number }>;
  if ((version?.user_version ?? 0) < SCHEMA_VERSION) sqlite.exec('DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS assets;');
  sqlite.exec(migration);
  sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
  return { sqlite, orm: drizzle(sqlite, { schema }) };
}

interface ProjectInput { id: string; name: string; }
interface VersionInput { id: string; projectId: string; parentId?: string; hash: string; ir: DesignIR; }
interface ApprovalInput { id: string; runId: string; projectId: string; stage: 'identity' | 'prototype' | 'finalization'; approverRole: 'captain'; versionId: string; versionHash: string; decision: 'approved' | 'rejected'; rationale: string; }
interface EventInput { id: string; runId: string; type: string; payload: Record<string, unknown>; }
interface RunInput { id: string; projectId: string; }

export class ProjectRepository {
  private writer = Promise.resolve();
  constructor(private readonly db: LocalDatabase) {}

  private write<T>(operation: () => T): Promise<T> { const next = this.writer.then(operation); this.writer = next.then(() => undefined, () => undefined); return next; }
  async createProject(input: ProjectInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.projects).values({ ...input, createdAt: new Date().toISOString() }).run(); }); }
  async createRun(input: RunInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.runs).values({ ...input, createdAt: new Date().toISOString() }).run(); }); }
  async saveTask(task: AgentTask, runId: string): Promise<void> { await this.write(() => { this.db.orm.insert(schema.tasks).values({ id: task.id, runId, attempt: task.attempt, stage: task.stage, role: task.role, state: task.state, baseVersionId: task.baseVersionId, payload: JSON.stringify(task) }).run(); }); }
  async savePatch(patch: Patch, runId: string): Promise<void> { await this.write(() => { this.db.orm.insert(schema.patches).values({ id: hashJson(patch), runId, baseVersionId: patch.baseVersionId, payload: JSON.stringify(patch), createdAt: new Date().toISOString() }).run(); }); }
  async saveVersion(input: VersionInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.versions).values({ id: input.id, projectId: input.projectId, parentId: input.parentId ?? null, hash: input.hash, ir: JSON.stringify(designIRSchema.parse(input.ir)), createdAt: new Date().toISOString() }).run(); }); }
  async createApproval(input: ApprovalInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.approvals).values({ ...input, createdAt: new Date().toISOString() }).run(); }); }
  async appendEvent(input: EventInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.events).values({ id: input.id, runId: input.runId, type: input.type, payload: JSON.stringify(input.payload), createdAt: new Date().toISOString() }).run(); }); }
  async getRun(runId: string): Promise<{ id: string; projectId: string } | undefined> {
    const row = this.db.sqlite.prepare('SELECT id, project_id AS projectId FROM runs WHERE id = ?').get(runId) as { id: string; projectId: string } | undefined;
    return row;
  }

  async listVersions(projectId: string): Promise<Array<{ id: string; parentId?: string; hash: string; ir: DesignIR }>> {
    return (this.db.sqlite.prepare('SELECT id, parent_id AS parentId, hash, ir FROM versions WHERE project_id = ? ORDER BY rowid').all(projectId) as Array<{ id: string; parentId: string | null; hash: string; ir: string }>)
      .map((row) => ({ id: row.id, ...(row.parentId ? { parentId: row.parentId } : {}), hash: row.hash, ir: designIRSchema.parse(JSON.parse(row.ir)) }));
  }

  async listApprovals(runId: string): Promise<Approval[]> {
    return (this.db.sqlite.prepare('SELECT id, stage, approver_role AS approverRole, version_id AS versionId, version_hash AS versionHash, decision, rationale, created_at AS createdAt FROM approvals WHERE run_id = ? ORDER BY rowid').all(runId) as Approval[]);
  }

  async listEvents(runId: string): Promise<Array<{ id: string; type: string; payload: Record<string, unknown> }>> { return this.db.sqlite.prepare('SELECT id, type, payload FROM events WHERE run_id = ? ORDER BY rowid').all(runId).map((row) => { const item = row as { id: string; type: string; payload: string }; return { id: item.id, type: item.type, payload: JSON.parse(item.payload) as Record<string, unknown> }; }); }
  dump(): string {
    const tables = (this.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((table) => table.name);
    return JSON.stringify(Object.fromEntries(tables.map((table) => [table, this.db.sqlite.prepare(`SELECT * FROM "${table}"`).all()])));
  }
}

export function scanSecrets(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [['password', /["']?password["']?\s*[:=]/i], ['token', /(?:^|["'\s])token(?:["']?\s*[:=])/i], ['secret', /["']?secret["']?\s*[:=]/i], ['api_key', /["']?api[_-]?key["']?\s*[:=]/i], ['private_key', /["']?private[_-]?key["']?\s*[:=]/i], ['oauth', /["']?oauth[_-]?token["']?\s*[:=]/i]];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
