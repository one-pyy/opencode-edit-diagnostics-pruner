import { Database } from 'bun:sqlite';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupDatabase, checkedBackupPath } from './backup.mjs';
import { isRecord, pruneDiagnostics } from './filter.mjs';

function validateSchema(db) {
  const required = {
    session: ['id', 'directory'],
    part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'],
    event: ['id', 'aggregate_id', 'seq', 'type', 'data'],
  };
  for (const [table, columns] of Object.entries(required)) {
    if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new Error(`Unsupported schema: missing table ${table}`);
    }
    const actual = new Set(db.query(`PRAGMA table_info("${table}")`).all().map(column => column.name));
    if (columns.some(column => !actual.has(column))) throw new Error(`Unsupported schema: ${table} columns`);
  }
}

function parse(raw) {
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); }
  catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function preflight(db, sessionID) {
  let activeParts = 0;
  for (const row of db.query('SELECT data FROM part WHERE session_id=?').iterate(sessionID)) {
    const value = parse(row.data);
    if (value?.type === 'tool' && ['pending', 'running'].includes(value.state?.status)) activeParts++;
  }
  return activeParts;
}

function filterPart(part, directory) {
  if (!isRecord(part)) return { skipped: true };
  if (part.type !== 'tool' || !['apply_patch', 'edit', 'write'].includes(part.tool)) return {};
  if (!isRecord(part.state)) return { skipped: true };
  if (['pending', 'running'].includes(part.state.status)) return {};
  if (part.state.status !== 'completed') return { skipped: true };
  const result = pruneDiagnostics(part.tool, part.state.input, part.state.metadata, directory);
  if (!result.removedFiles) return {};
  return { value: { ...part, state: { ...part.state, metadata: result.metadata } }, removedFiles: result.removedFiles };
}

function scan(db, sessionID, directory, apply, report) {
  const updatePart = db.query('UPDATE part SET data=? WHERE id=? AND session_id=? AND data=?');
  const updateEvent = db.query('UPDATE event SET data=? WHERE id=? AND aggregate_id=? AND type=? AND data=?');
  const record = (kind, raw, next, removedFiles, update) => {
    if (apply && update(next).changes !== 1) throw new Error(`Row conflict in ${kind}`);
    report[kind]++;
    report.removedDiagnosticFiles += removedFiles;
    report.removedBytes += Buffer.byteLength(raw) - Buffer.byteLength(next);
  };
  for (const row of db.query('SELECT id, message_id, data FROM part WHERE session_id=?').iterate(sessionID)) {
    const part = parse(row.data);
    if (!isRecord(part) || (part.id !== undefined && part.id !== row.id)
      || (part.sessionID !== undefined && part.sessionID !== sessionID)
      || (part.messageID !== undefined && part.messageID !== row.message_id)) {
      report.skippedRows++;
      continue;
    }
    const result = filterPart(part, directory);
    if (result.skipped) report.skippedRows++;
    if (result.value) record('partRows', row.data, JSON.stringify(result.value), result.removedFiles,
      next => updatePart.run(next, row.id, sessionID, row.data));
  }
  for (const row of db.query("SELECT id, data FROM event WHERE aggregate_id=? AND type='message.part.updated.1'").iterate(sessionID)) {
    const event = parse(row.data);
    if (!isRecord(event) || event.sessionID !== sessionID || !isRecord(event.part)
      || event.part.sessionID !== sessionID || typeof event.part.id !== 'string' || !event.part.id
      || typeof event.part.messageID !== 'string' || !event.part.messageID) {
      report.skippedRows++;
      continue;
    }
    const result = filterPart(event.part, directory);
    if (result.skipped) report.skippedRows++;
    if (result.value) record('eventRows', row.data, JSON.stringify({ ...event, part: result.value }), result.removedFiles,
      next => updateEvent.run(next, row.id, sessionID, 'message.part.updated.1', row.data));
  }
}

export function cleanHistory({ dbPath, sessionID, apply = false, sessionStopped = false, backupPath, noBackup = false,
  backup = backupDatabase }) {
  if (typeof dbPath !== 'string' || typeof sessionID !== 'string' || !sessionID) {
    throw new Error('Explicit --db and --session are required');
  }
  if (apply && !sessionStopped) throw new Error('Stop the host/session first and pass --session-stopped');
  if (noBackup && !apply) throw new Error('--no-backup requires --apply');
  if (noBackup && backupPath) throw new Error('--no-backup conflicts with --backup');
  const source = realpathSync(dbPath);
  const db = new Database(source, { readonly: !apply, create: false, strict: true });
  let transaction = false;
  const report = { mode: apply ? 'apply' : 'preview', sessionID, partRows: 0, eventRows: 0,
    removedDiagnosticFiles: 0, removedBytes: 0, skippedRows: 0, activeParts: 0 };
  try {
    db.exec('PRAGMA busy_timeout=5000');
    // Keep this same connection alive across backup: data_version detects other commits.
    const version = db.query('PRAGMA data_version').get().data_version;
    validateSchema(db);
    const session = db.query('SELECT directory FROM session WHERE id=?').get(sessionID);
    if (!session || typeof session.directory !== 'string') throw new Error('Session missing or invalid directory');
    report.activeParts = preflight(db, sessionID);
    if (apply && report.activeParts) throw new Error('Session has pending/running tool parts; finish or stop it before apply');
    if (apply) {
      report.backupSkipped = noBackup;
      if (!noBackup) {
        const requested = backupPath ?? path.join(path.dirname(source),
          `${path.basename(source)}.pruner-${Date.now()}-${randomUUID()}.backup.sqlite`);
        report.backupPath = checkedBackupPath(source, requested);
        backup(source, report.backupPath);
      }
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
      if (db.query('PRAGMA data_version').get().data_version !== version) {
        throw new Error('Source database changed during preflight; no cleanup applied. Stop host and retry');
      }
    } else {
      db.exec('BEGIN');
      transaction = true;
    }
    scan(db, sessionID, session.directory, apply, report);
    db.exec('COMMIT');
    transaction = false;
    return report;
  } finally {
    try { if (transaction) db.exec('ROLLBACK'); }
    finally { db.close(); }
  }
}
