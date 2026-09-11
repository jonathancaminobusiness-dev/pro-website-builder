import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { designIRSchema, hashJson, imagerySourceSchema, RASTER_IMAGERY_SOURCE, type AgentTask, type Approval, type DesignIR, type ImagerySource, type Patch } from '@pwb/domain';
import { IDENTITY_BRIEFING, normalizeIdentityBriefing } from '../identity-briefing.js';
import * as schema from './schema.js';

export interface LocalDatabase { sqlite: Database.Database; orm: BetterSQLite3Database<typeof schema>; }
const sqlIdentityBriefing = IDENTITY_BRIEFING.replaceAll("'", "''");
const migration = `PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, parent_id TEXT, hash TEXT NOT NULL, ir TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, briefing TEXT NOT NULL DEFAULT '${sqlIdentityBriefing}', conversation TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT NOT NULL, run_id TEXT NOT NULL, attempt INTEGER NOT NULL, stage TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, base_version_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, id, attempt));
CREATE TABLE IF NOT EXISTS patches (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, base_version_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL, stage TEXT NOT NULL, approver_role TEXT NOT NULL, version_id TEXT NOT NULL, version_hash TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prototype_runs (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, step TEXT NOT NULL, detail TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL);`;

/** The schema the migration brings a database up to; tests assert against this rather than a copied literal. */
export const SCHEMA_VERSION = 5;

export function openDatabase(filename: string): LocalDatabase {
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const [version] = sqlite.pragma('user_version') as Array<{ user_version: number }>;
  const current = version?.user_version ?? 0;
  // Each step is the one its own version introduced, so a later bump does not
  // re-run an earlier drop over rows that step never meant to lose.
  if (current < 2) sqlite.exec('DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS assets;');
  sqlite.exec(migration);
  if (current < 3) sqlite.transaction(() => renameImagerySources(sqlite))();
  if (current < 4) sqlite.transaction(() => addRunBriefing(sqlite))();
  if (current < 5) sqlite.transaction(() => addRunConversation(sqlite))();
  sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
  return { sqlite, orm: drizzle(sqlite, { schema }) };
}

/**
 * The briefing conversation of an execution, as one nullable column. A database
 * written before this version has no conversations to lose, and a row whose
 * column is still NULL reads back as an execution that never started one — which
 * is exactly what it is.
 */
function addRunConversation(sqlite: Database.Database): void {
  const columns = sqlite.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'conversation')) return;
  sqlite.exec('ALTER TABLE runs ADD COLUMN conversation TEXT');
}

function addRunBriefing(sqlite: Database.Database): void {
  const columns = sqlite.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'briefing')) return;
  sqlite.exec(`ALTER TABLE runs ADD COLUMN briefing TEXT NOT NULL DEFAULT '${sqlIdentityBriefing}'`);
}

/**
 * Version 3 closed the imagery vocabulary, so a document written before it can
 * name a source this build no longer parses — and every stored version of a
 * project is parsed to read any run of it. The documents are rewritten in place
 * rather than dropped: the raster source keeps its meaning under its new name,
 * and a source this build does not know becomes `manual`, which generates
 * nothing. A rewritten row is stored as the schema normalizes it, under the hash
 * of that same normalized document, because that is what every reader of the row
 * sees; the content-derived row id is not touched, because `parent_id` and
 * `approvals.version_id` point at it.
 */
function renameImagerySources(sqlite: Database.Database): void {
  const rows = sqlite.prepare('SELECT id, ir FROM versions').all() as Array<{ id: string; ir: string }>;
  const update = sqlite.prepare('UPDATE versions SET ir = ?, hash = ? WHERE id = ?');
  for (const row of rows) {
    let document: { identity?: { imagery?: { allowedSources?: unknown } } };
    try { document = JSON.parse(row.ir) as typeof document; } catch { continue; }
    const imagery = document.identity?.imagery;
    const sources = imagery?.allowedSources;
    if (!imagery || !Array.isArray(sources)) continue;
    const renamed = [...new Set(sources.map(knownImagerySource))];
    if (renamed.length === sources.length && renamed.every((source, index) => source === sources[index])) continue;
    imagery.allowedSources = renamed;
    const normalized = designIRSchema.safeParse(document);
    const rewritten = normalized.success ? normalized.data : document;
    update.run(JSON.stringify(rewritten), hashJson(rewritten), row.id);
  }
}

function knownImagerySource(source: unknown): ImagerySource {
  if (source === 'higgsfield') return RASTER_IMAGERY_SOURCE;
  const known = imagerySourceSchema.safeParse(source);
  return known.success ? known.data : 'manual';
}

interface ProjectInput { id: string; name: string; }
interface VersionInput { id: string; projectId: string; parentId?: string; hash: string; ir: DesignIR; }
interface ApprovalInput { id: string; runId: string; projectId: string; stage: 'identity' | 'prototype' | 'finalization'; approverRole: 'captain' | 'fixture'; versionId: string; versionHash: string; decision: 'approved' | 'rejected'; rationale: string; }
interface EventInput { id: string; runId: string; type: string; payload: Record<string, unknown>; }
/** A Gate 2 run as it survives a restart: its progress in columns, its review in the payload. */
export interface PrototypeRunRow { id: string; status: string; step: string; detail: string; error?: string; startedAt: string; updatedAt: string; payload: Record<string, unknown>; }
interface RunInput { id: string; projectId: string; briefing?: string; }

export class ProjectRepository {
  private writer = Promise.resolve();
  constructor(private readonly db: LocalDatabase) {}

  private write<T>(operation: () => T): Promise<T> { const next = this.writer.then(operation); this.writer = next.then(() => undefined, () => undefined); return next; }
  async createProject(input: ProjectInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.projects).values({ ...input, createdAt: new Date().toISOString() }).run(); }); }
  async createRun(input: RunInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.runs).values({ id: input.id, projectId: input.projectId, briefing: normalizeIdentityBriefing(input.briefing), createdAt: new Date().toISOString() }).run(); }); }
  async updateRunBriefing(runId: string, briefing: string): Promise<void> { await this.write(() => { this.db.sqlite.prepare('UPDATE runs SET briefing = ? WHERE id = ?').run(briefing, runId); }); }
  async saveTask(task: AgentTask, runId: string): Promise<void> { await this.write(() => { this.db.orm.insert(schema.tasks).values({ id: task.id, runId, attempt: task.attempt, stage: task.stage, role: task.role, state: task.state, baseVersionId: task.baseVersionId, payload: JSON.stringify(task) }).run(); }); }
  async savePatch(patch: Patch, runId: string): Promise<void> { await this.write(() => { this.db.orm.insert(schema.patches).values({ id: hashJson(patch), runId, baseVersionId: patch.baseVersionId, payload: JSON.stringify(patch), createdAt: new Date().toISOString() }).run(); }); }
  async saveVersion(input: VersionInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.versions).values({ id: input.id, projectId: input.projectId, parentId: input.parentId ?? null, hash: input.hash, ir: JSON.stringify(designIRSchema.parse(input.ir)), createdAt: new Date().toISOString() }).run(); }); }
  async createApproval(input: ApprovalInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.approvals).values({ ...input, createdAt: new Date().toISOString() }).run(); }); }
  async appendEvent(input: EventInput): Promise<void> { await this.write(() => { this.db.orm.insert(schema.events).values({ id: input.id, runId: input.runId, type: input.type, payload: JSON.stringify(input.payload), createdAt: new Date().toISOString() }).run(); }); }
  async savePrototypeRun(input: PrototypeRunRow): Promise<void> {
    await this.write(() => {
      const row = { id: input.id, status: input.status, step: input.step, detail: input.detail, error: input.error ?? null, startedAt: input.startedAt, updatedAt: input.updatedAt, payload: JSON.stringify(input.payload) };
      this.db.orm.insert(schema.prototypeRuns).values(row).onConflictDoUpdate({ target: schema.prototypeRuns.id, set: row }).run();
    });
  }

  listPrototypeRuns(): PrototypeRunRow[] {
    return this.db.sqlite.prepare('SELECT id, status, step, detail, error, started_at, updated_at, payload FROM prototype_runs ORDER BY started_at').all().map((row) => {
      const item = row as { id: string; status: string; step: string; detail: string; error: string | null; started_at: string; updated_at: string; payload: string };
      return { id: item.id, status: item.status, step: item.step, detail: item.detail, ...(item.error === null ? {} : { error: item.error }), startedAt: item.started_at, updatedAt: item.updated_at, payload: JSON.parse(item.payload) as Record<string, unknown> };
    });
  }

  /**
   * The conversation, and the briefing a confirmation moved the execution onto,
   * in one transaction: a confirmation records itself and moves the execution
   * together or not at all, so no execution ever carries a briefing its
   * transcript does not name. A run that does not exist yet simply has nothing
   * to write to.
   */
  async saveConversation(runId: string, conversation: string, briefing?: string): Promise<void> {
    await this.write(() => this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare('UPDATE runs SET conversation = ? WHERE id = ?').run(conversation, runId);
      if (briefing !== undefined) this.db.sqlite.prepare('UPDATE runs SET briefing = ? WHERE id = ?').run(briefing, runId);
    })());
  }

  async getRun(runId: string): Promise<{ id: string; projectId: string; briefing: string; conversation?: string } | undefined> {
    const row = this.db.sqlite.prepare('SELECT id, project_id AS projectId, briefing, conversation FROM runs WHERE id = ?').get(runId) as { id: string; projectId: string; briefing: string; conversation: string | null } | undefined;
    return row ? { id: row.id, projectId: row.projectId, briefing: row.briefing, ...(row.conversation === null ? {} : { conversation: row.conversation }) } : undefined;
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
