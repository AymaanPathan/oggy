import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import type { Approval, MemoryItem, Run, StepTemplate, Workflow, WorkflowSchedule } from './shared/types.js'

export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    source TEXT NOT NULL,
    intent TEXT NOT NULL,
    status TEXT NOT NULL,
    steps_json TEXT NOT NULL,
    summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_via TEXT
  );
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL,
    steps_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_run_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS memory (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`)

// Added after the first release: databases created before it lack the column.
const runColumns = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name)
if (!runColumns.includes('label')) db.exec('ALTER TABLE runs ADD COLUMN label TEXT')
if (!runColumns.includes('requested_by')) db.exec('ALTER TABLE runs ADD COLUMN requested_by TEXT')
if (!runColumns.includes('workflow_id')) db.exec('ALTER TABLE runs ADD COLUMN workflow_id TEXT')
const workflowColumns = (db.prepare('PRAGMA table_info(workflows)').all() as { name: string }[]).map((c) => c.name)
if (!workflowColumns.includes('asked')) db.exec('ALTER TABLE workflows ADD COLUMN asked TEXT')
if (!workflowColumns.includes('project')) db.exec('ALTER TABLE workflows ADD COLUMN project TEXT')
if (!workflowColumns.includes('schedule_json')) db.exec('ALTER TABLE workflows ADD COLUMN schedule_json TEXT')

export const newId = () => randomUUID()

/* ---------- runs ---------- */

type RunRow = {
  id: string; command: string; source: string; requested_by: string | null; intent: string; label: string | null; workflow_id: string | null; status: string
  steps_json: string; summary: string | null; created_at: number; updated_at: number
}
const toRun = (r: RunRow): Run => ({
  id: r.id,
  command: r.command,
  source: r.source as Run['source'],
  requestedBy: r.requested_by ?? undefined,
  intent: r.intent as Run['intent'],
  label: r.label ?? undefined,
  workflowId: r.workflow_id ?? undefined,
  status: r.status as Run['status'],
  steps: JSON.parse(r.steps_json),
  summary: r.summary ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export const runs = {
  save(run: Run): Run {
    run.updatedAt = Date.now()
    db.prepare(
      `INSERT INTO runs (id, command, source, requested_by, intent, label, workflow_id, status, steps_json, summary, created_at, updated_at)
       VALUES (@id, @command, @source, @requestedBy, @intent, @label, @workflowId, @status, @steps, @summary, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET intent=@intent, label=@label, workflow_id=@workflowId, status=@status, steps_json=@steps, summary=@summary, updated_at=@updatedAt`
    ).run({
      ...run,
      requestedBy: run.requestedBy ?? null,
      label: run.label ?? null,
      workflowId: run.workflowId ?? null,
      steps: JSON.stringify(run.steps),
      summary: run.summary ?? null
    })
    return run
  },
  get(id: string): Run | undefined {
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
    return row && toRun(row)
  },
  list(limit = 50): Run[] {
    // A workflow's history is its record, so it doesn't age out with everyday jobs.
    return (db.prepare('SELECT * FROM runs WHERE id IN (SELECT id FROM runs ORDER BY created_at DESC LIMIT ?) OR workflow_id IS NOT NULL ORDER BY created_at DESC').all(limit) as RunRow[]).map(toRun)
  },
  /** Most recent run that is not the given one and not itself a workflow-management command. */
  lastReplayable(excludeId: string): Run | undefined {
    const row = db
      .prepare(
        `SELECT * FROM runs WHERE id != ? AND intent NOT IN ('workflow.save','workflow.list','memory.remember','quick','unknown')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(excludeId) as RunRow | undefined
    return row && toRun(row)
  }
}

/* ---------- approvals ---------- */

type ApprovalRow = {
  id: string; run_id: string; step_id: string; action: string; status: string
  created_at: number; decided_at: number | null; decided_via: string | null
}
const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  runId: r.run_id,
  stepId: r.step_id,
  action: r.action,
  status: r.status as Approval['status'],
  createdAt: r.created_at,
  decidedAt: r.decided_at ?? undefined,
  decidedVia: (r.decided_via ?? undefined) as Approval['decidedVia']
})

export const approvals = {
  create(runId: string, stepId: string, action: string): Approval {
    const a: Approval = { id: newId(), runId, stepId, action, status: 'pending', createdAt: Date.now() }
    db.prepare(
      `INSERT INTO approvals (id, run_id, step_id, action, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(a.id, runId, stepId, action, a.status, a.createdAt)
    return a
  },
  get(id: string): Approval | undefined {
    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined
    return row && toApproval(row)
  },
  forStep(runId: string, stepId: string): Approval | undefined {
    const row = db
      .prepare('SELECT * FROM approvals WHERE run_id = ? AND step_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(runId, stepId) as ApprovalRow | undefined
    return row && toApproval(row)
  },
  decide(id: string, approve: boolean, via: Approval['decidedVia']): Approval | undefined {
    db.prepare(
      `UPDATE approvals SET status = ?, decided_at = ?, decided_via = ? WHERE id = ? AND status = 'pending'`
    ).run(approve ? 'approved' : 'rejected', Date.now(), via ?? null, id)
    return this.get(id)
  },
  list(onlyPending = false): Approval[] {
    const sql = onlyPending
      ? `SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC`
      : `SELECT * FROM approvals ORDER BY created_at DESC LIMIT 50`
    return (db.prepare(sql).all() as ApprovalRow[]).map(toApproval)
  }
}

/* ---------- workflows ---------- */

type WorkflowRow = {
  id: string; name: string; description: string; steps_json: string; asked: string | null; project: string | null; schedule_json: string | null
  created_at: number; last_run_at: number | null
}
const toWorkflow = (r: WorkflowRow): Workflow => ({
  id: r.id,
  name: r.name,
  description: r.description,
  steps: JSON.parse(r.steps_json),
  asked: r.asked ?? undefined,
  project: r.project ?? undefined,
  schedule: r.schedule_json ? JSON.parse(r.schedule_json) : undefined,
  createdAt: r.created_at,
  lastRunAt: r.last_run_at ?? undefined
})

export const workflows = {
  upsert(name: string, description: string, steps: StepTemplate[], extra: { asked?: string; project?: string; schedule?: WorkflowSchedule } = {}): Workflow {
    const existing = this.byName(name)
    const id = existing?.id ?? newId()
    db.prepare(
      `INSERT INTO workflows (id, name, description, steps_json, asked, project, schedule_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET description = excluded.description, steps_json = excluded.steps_json, asked = excluded.asked, project = excluded.project, schedule_json = excluded.schedule_json`
    ).run(id, name, description, JSON.stringify(steps), extra.asked ?? null, extra.project ?? null, extra.schedule ? JSON.stringify(extra.schedule) : null, existing?.createdAt ?? Date.now())
    return this.byName(name)!
  },
  remove(id: string): boolean {
    return db.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes > 0
  },
  byName(name: string): Workflow | undefined {
    const row = db.prepare('SELECT * FROM workflows WHERE name = ?').get(name) as WorkflowRow | undefined
    return row && toWorkflow(row)
  },
  touch(id: string) {
    db.prepare('UPDATE workflows SET last_run_at = ? WHERE id = ?').run(Date.now(), id)
  },
  list(): Workflow[] {
    return (db.prepare('SELECT * FROM workflows ORDER BY name').all() as WorkflowRow[]).map(toWorkflow)
  }
}

/* ---------- memory ---------- */

export const memory = {
  set(key: string, value: string) {
    db.prepare(
      `INSERT INTO memory (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, Date.now())
  },
  get(key: string): string | undefined {
    return (db.prepare('SELECT value FROM memory WHERE key = ?').get(key) as { value: string } | undefined)?.value
  },
  list(): MemoryItem[] {
    return (db.prepare('SELECT key, value, updated_at AS updatedAt FROM memory ORDER BY key').all() as MemoryItem[])
  }
}
