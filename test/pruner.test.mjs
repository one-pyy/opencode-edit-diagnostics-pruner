import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pruneDiagnostics } from '../filter.mjs';
import plugin from '../plugin.mjs';
import { cleanHistory } from '../history-db.mjs';
import { backupDatabase } from '../backup.mjs';

const directory = '/synthetic/project';
const edited = `${directory}/edited.ts`;
const unrelated = `${directory}/other.ts`;
function state(tool = 'edit') {
  return {
    status: 'completed', input: { filePath: 'edited.ts' }, output: 'AI error text stays',
    metadata: { diagnostics: { [edited]: [{ message: 'keep' }], [unrelated]: [{ message: 'drop' }], relative: ['unknown'] },
      files: tool === 'apply_patch' ? [{ filePath: edited, type: 'update' }] : undefined, other: 42 },
    time: { start: 1, end: 2 },
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-pruner-'));
  const file = join(root, 'synthetic.sqlite');
  const db = new Database(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);
    CREATE TABLE unrelated_secret(id INTEGER PRIMARY KEY, value TEXT);`);
  db.run('INSERT INTO session VALUES (?, ?)', ['ses_synthetic', directory]);
  db.run('INSERT INTO session VALUES (?, ?)', ['ses_other_synthetic', directory]);
  db.run('INSERT INTO unrelated_secret VALUES (1, ?)', ['synthetic sentinel']);
  for (const [index, tool] of ['edit', 'write', 'apply_patch', 'bash'].entries()) {
    const id = `part_synthetic_${index}`;
    const part = { type: 'tool', tool, callID: 'synthetic-call', state: state(tool), metadata: { provider: 'keep' } };
    db.run('INSERT INTO part VALUES (?, ?, ?, 1, 2, ?)', [id, 'msg_synthetic', 'ses_synthetic', JSON.stringify(part)]);
    db.run('INSERT INTO event VALUES (?, ?, ?, ?, ?)', [`event_synthetic_${index}`, 'ses_synthetic', index,
      'message.part.updated.1', JSON.stringify({ sessionID: 'ses_synthetic', part: { ...part, id,
        sessionID: 'ses_synthetic', messageID: 'msg_synthetic' }, time: 2 })]);
  }
  db.run('INSERT INTO part VALUES (?, ?, ?, 1, 2, ?)', ['part_other', 'msg_other', 'ses_other_synthetic',
    JSON.stringify({ type: 'tool', tool: 'edit', state: state() })]);
  return { root, file, db, backup: join(root, 'backup.sqlite'), close() { db.close(); rmSync(root, { recursive: true }); } };
}
function runCLI(args) {
  return spawnSync(process.execPath, [join(import.meta.dir, '..', 'history.mjs'), ...args], { encoding: 'utf8' });
}

test('explicit no-backup skips backup and rejects conflicting options before writes', () => {
  const f = fixture();
  try {
    const before = f.db.query('SELECT * FROM part ORDER BY id').all();
    expect(runCLI(['--db', f.file, '--session', 'ses_synthetic', '--no-backup']).status).not.toBe(0);
    expect(runCLI(['--db', f.file, '--session', 'ses_synthetic', '--apply', '--session-stopped',
      '--no-backup', '--backup', f.backup]).status).not.toBe(0);
    expect(f.db.query('SELECT * FROM part ORDER BY id').all()).toEqual(before);
    const report = cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic', apply: true,
      sessionStopped: true, noBackup: true, backup: () => { throw new Error('must not call backup'); } });
    expect(report.backupSkipped).toBe(true);
    expect(report.backupPath).toBeUndefined();
    expect(report.partRows).toBe(3);
    expect(report.eventRows).toBe(3);
    const result = runCLI(['--db', f.file, '--session', 'ses_synthetic', '--apply', '--session-stopped', '--no-backup']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).backupSkipped).toBe(true);
  } finally { f.close(); }
});

test('shared filter keeps edited paths, unknown keys, output and unrelated metadata', () => {
  for (const tool of ['edit', 'write', 'apply_patch']) {
    const original = state(tool);
    const before = structuredClone(original);
    const result = pruneDiagnostics(tool, original.input, original.metadata, directory);
    expect(result.removedFiles).toBe(1);
    expect(result.metadata.diagnostics).toEqual({ [edited]: before.metadata.diagnostics[edited], relative: ['unknown'] });
    expect(result.metadata.other).toBe(42);
    expect(original).toEqual(before);
  }
});

test('missing or ambiguous paths never prune; foreign tool never prunes', () => {
  const metadata = state().metadata;
  for (const args of [{}, { filePath: '' }, { filePath: 'C:\\relative.ts' }]) {
    expect(pruneDiagnostics('edit', args, metadata, directory).metadata).toBe(metadata);
  }
  for (const files of [[], null, [{ filePath: edited }], [{ filePath: edited, type: 'update' }, {}],
    [{ filePath: edited, type: 'move' }], [{ filePath: 'relative.ts', type: 'update' }]]) {
    const value = { ...metadata, files };
    expect(pruneDiagnostics('apply_patch', {}, value, directory).metadata).toBe(value);
  }
  expect(pruneDiagnostics('bash', { filePath: edited }, metadata, directory).metadata).toBe(metadata);
});

test('Windows root-relative edit paths and inconsistent move records preserve diagnostics', () => {
  const metadata = { diagnostics: { 'C:\\demo\\edited.ts': [1], 'C:\\demo\\other.ts': [2] } };
  for (const filePath of ['/edited.ts', '\\edited.ts']) {
    expect(pruneDiagnostics('edit', { filePath }, metadata, 'C:\\demo').metadata).toBe(metadata);
  }
  const inconsistent = { ...state().metadata, files: [{ filePath: edited, type: 'update', movePath: unrelated }] };
  expect(pruneDiagnostics('apply_patch', {}, inconsistent, directory).metadata).toBe(inconsistent);
});

test('moves preserve both paths, canonical POSIX and Windows paths match safely', () => {
  const destination = `${directory}/moved.ts`;
  const metadata = { diagnostics: { [edited]: [1], [destination]: [2], [unrelated]: [3] },
    files: [{ filePath: edited, type: 'move', movePath: destination }] };
  expect(pruneDiagnostics('apply_patch', {}, metadata, directory).metadata.diagnostics).toEqual({ [edited]: [1], [destination]: [2] });
  const windows = { diagnostics: { 'C:\\demo\\edited.ts': [1], 'C:/demo/other.ts': [2], 'C:unknown': [3] } };
  expect(pruneDiagnostics('write', { filePath: '.\\edited.ts' }, windows, 'C:\\demo').metadata.diagnostics)
    .toEqual({ 'C:\\demo\\edited.ts': [1], 'C:unknown': [3] });
  expect(pruneDiagnostics('edit', { filePath: './folder/../edited.ts' }, state().metadata, directory).removedFiles).toBe(1);
});

test('hook mutates final metadata only', async () => {
  const hooks = await plugin({ directory });
  const output = { title: 'title', output: 'all AI output', metadata: state().metadata };
  await hooks['tool.execute.after']({ tool: 'edit', args: { filePath: edited } }, output);
  expect(output.title).toBe('title');
  expect(output.output).toBe('all AI output');
  expect(output.metadata.diagnostics[edited]).toEqual([{ message: 'keep' }]);
  expect(output.metadata.diagnostics[unrelated]).toBeUndefined();
});

test('multi-file patch keeps every changed file and later hooks see the filtered result', async () => {
  const second = `${directory}/second.ts`;
  const metadata = { files: [{ filePath: edited, type: 'update' }, { filePath: second, type: 'add' }],
    diagnostics: { [edited]: [1], [second]: [2], [unrelated]: [3] }, other: 42 };
  const output = { title: 'patch', output: 'complete AI diagnostics', metadata };
  const hooks = await plugin({ directory });
  let observed;
  const callbacks = [hooks['tool.execute.after'], async (_input, value) => { observed = value; }];
  for (const callback of callbacks) await callback({ tool: 'apply_patch', args: {} }, output);
  expect(observed).toBe(output);
  expect(observed.metadata.diagnostics).toEqual({ [edited]: [1], [second]: [2] });
  expect(observed.metadata.other).toBe(42);
  expect(observed.output).toBe('complete AI diagnostics');
});

test('POSIX drive-looking relative paths preserve edited diagnostics in hook and historical copies', async () => {
  const actual = `${directory}/C:/demo/edited.ts`;
  const input = { filePath: 'C:/demo/edited.ts' };
  const metadata = { diagnostics: { [actual]: [1], [unrelated]: [2] }, other: 42 };
  for (const tool of ['edit', 'write']) {
    const hooks = await plugin({ directory });
    const output = { title: 'edit', output: 'AI errors', metadata };
    await hooks['tool.execute.after']({ tool, args: input }, output);
    expect(output.metadata.diagnostics).toEqual({ [actual]: [1] });
    expect(output.output).toBe('AI errors');
  }
  const f = fixture();
  try {
    const part = { type: 'tool', tool: 'write', state: { ...state(), input, metadata } };
    f.db.run('UPDATE part SET data=? WHERE id=?', [JSON.stringify(part), 'part_synthetic_1']);
    const event = { sessionID: 'ses_synthetic', part: { ...part, id: 'part_synthetic_1',
      sessionID: 'ses_synthetic', messageID: 'msg_synthetic' }, time: 2 };
    f.db.run('UPDATE event SET data=? WHERE id=?', [JSON.stringify(event), 'event_synthetic_1']);
    cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic', apply: true, sessionStopped: true, backupPath: f.backup });
    const saved = JSON.parse(f.db.query('SELECT data FROM part WHERE id=?').get('part_synthetic_1').data);
    const replay = JSON.parse(f.db.query('SELECT data FROM event WHERE id=?').get('event_synthetic_1').data);
    expect(saved.state.metadata.diagnostics).toEqual({ [actual]: [1] });
    expect(replay.part.state).toEqual(saved.state);
    expect(saved.state.output).toBe('AI error text stays');
  } finally { f.close(); }
});

test('default CLI preview is read-only and needs explicit source/session', () => {
  const f = fixture();
  try {
    const before = f.db.query('SELECT * FROM part').all();
    const result = runCLI(['--db', f.file, '--session', 'ses_synthetic']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.mode).toBe('preview');
    expect(report.partRows).toBe(3);
    expect(report.eventRows).toBe(3);
    expect(report.removedDiagnosticFiles).toBe(6);
    expect(f.db.query('SELECT * FROM part').all()).toEqual(before);
    expect(runCLI([]).status).not.toBe(0);
    expect(runCLI(['--db', f.file, '--session', 'missing']).status).not.toBe(0);
  } finally { f.close(); }
});

test('apply updates replay copies; full validated backup includes WAL and restores prechange', () => {
  const f = fixture();
  try {
    const originalParts = f.db.query('SELECT * FROM part ORDER BY id').all();
    const originalEvents = f.db.query('SELECT * FROM event ORDER BY id').all();
    const result = runCLI(['--db', f.file, '--session', 'ses_synthetic', '--apply', '--session-stopped', '--backup', f.backup]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.partRows).toBe(3);
    expect(report.eventRows).toBe(3);
    expect(report.removedBytes).toBeGreaterThan(0);
    expect(statSync(f.backup).mode & 0o777).toBe(0o600);
    const backup = new Database(f.backup, { readonly: true });
    try {
      expect(backup.query('PRAGMA quick_check').get().quick_check).toBe('ok');
      expect(backup.query('SELECT * FROM part ORDER BY id').all()).toEqual(originalParts);
      expect(backup.query('SELECT * FROM event ORDER BY id').all()).toEqual(originalEvents);
      expect(backup.query('SELECT value FROM unrelated_secret').get().value).toBe('synthetic sentinel');
    } finally { backup.close(); }
    const restoredPath = join(f.root, 'restored.sqlite');
    backupDatabase(f.backup, restoredPath);
    const restored = new Database(restoredPath, { readonly: true });
    try {
      expect(restored.query('SELECT * FROM part ORDER BY id').all()).toEqual(originalParts);
      expect(restored.query('SELECT * FROM event ORDER BY id').all()).toEqual(originalEvents);
    } finally { restored.close(); }
    for (const row of f.db.query('SELECT * FROM event ORDER BY seq').all()) {
      const event = JSON.parse(row.data);
      if (event.part.tool === 'bash') continue;
      const persisted = JSON.parse(f.db.query('SELECT data FROM part WHERE id=?').get(event.part.id).data);
      expect(event.part.state).toEqual(persisted.state);
      expect(event.part.state.metadata.diagnostics[unrelated]).toBeUndefined();
      expect(event.part.state.output).toBe('AI error text stays');
      expect(persisted.metadata).toEqual({ provider: 'keep' });
      expect(row.type).toBe('message.part.updated.1');
    }
    expect(f.db.query('SELECT * FROM part WHERE id=?').get('part_other')).toEqual(originalParts.find(p => p.id === 'part_other'));
    expect(runCLI(['--db', f.file, '--session', 'ses_synthetic', '--apply', '--session-stopped', '--backup', f.backup]).status).not.toBe(0);
  } finally { f.close(); }
});

test('requires stopped-session assertion and rejects current running parts', () => {
  const f = fixture();
  try {
    expect(runCLI(['--db', f.file, '--session', 'ses_synthetic', '--apply']).status).not.toBe(0);
    f.db.run('UPDATE part SET data=? WHERE id=?', [JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'running' } }), 'part_synthetic_3']);
    expect(runCLI(['--db', f.file, '--session', 'ses_synthetic', '--apply', '--session-stopped', '--backup', f.backup]).status).not.toBe(0);
    expect(readFileSync(f.file).length).toBeGreaterThan(0);
  } finally { f.close(); }
});

test('schema mismatch fails closed and malformed data is preserved', () => {
  const f = fixture();
  try {
    f.db.run('UPDATE part SET data=? WHERE id=?', ['{broken', 'part_synthetic_0']);
    const report = cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic' });
    expect(report.skippedRows).toBeGreaterThan(0);
    expect(f.db.query('SELECT data FROM part WHERE id=?').get('part_synthetic_0').data).toBe('{broken');
    f.db.exec('ALTER TABLE event RENAME COLUMN aggregate_id TO incompatible');
    expect(() => cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic' })).toThrow();
  } finally { f.close(); }
});

test('concurrent commit after backup aborts before any pruning', () => {
  const f = fixture();
  try {
    const before = f.db.query('SELECT * FROM part ORDER BY id').all();
    expect(() => cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic', apply: true, sessionStopped: true,
      backupPath: f.backup, backup: (source, target) => {
        backupDatabase(source, target);
        f.db.run('INSERT INTO unrelated_secret VALUES (2, ?)', ['concurrent synthetic commit']);
      } })).toThrow('changed');
    expect(f.db.query('SELECT * FROM part ORDER BY id').all()).toEqual(before);
  } finally { f.close(); }
});

test('update failure rolls back both tables', () => {
  const f = fixture();
  try {
    const before = f.db.query('SELECT * FROM part ORDER BY id').all();
    const eventsBefore = f.db.query('SELECT * FROM event ORDER BY id').all();
    f.db.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    expect(() => cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic', apply: true,
      sessionStopped: true, backupPath: f.backup })).toThrow();
    expect(f.db.query('SELECT * FROM part ORDER BY id').all()).toEqual(before);
    expect(f.db.query('SELECT * FROM event ORDER BY id').all()).toEqual(eventsBefore);
  } finally { f.close(); }
});

test('every completed event copy is filtered; historical running snapshots are preserved', () => {
  const f = fixture();
  try {
    const raw = f.db.query('SELECT data FROM event WHERE id=?').get('event_synthetic_0').data;
    f.db.run('INSERT INTO event VALUES (?, ?, ?, ?, ?)', ['duplicate_snapshot', 'ses_synthetic', 10, 'message.part.updated.1', raw]);
    const running = JSON.parse(raw);
    running.part.state.status = 'running';
    const runningRaw = JSON.stringify(running);
    f.db.run('INSERT INTO event VALUES (?, ?, ?, ?, ?)', ['running_snapshot', 'ses_synthetic', 11, 'message.part.updated.1', runningRaw]);
    const report = cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic', apply: true, sessionStopped: true, backupPath: f.backup });
    expect(report.eventRows).toBe(4);
    expect(JSON.parse(f.db.query('SELECT data FROM event WHERE id=?').get('duplicate_snapshot').data).part.state.metadata.diagnostics[unrelated]).toBeUndefined();
    expect(f.db.query('SELECT data FROM event WHERE id=?').get('running_snapshot').data).toBe(runningRaw);
  } finally { f.close(); }
});

test('duplicate row identities trigger conflict and atomic rollback', () => {
  const f = fixture();
  try {
    f.db.exec('ALTER TABLE event RENAME TO original_event; CREATE TABLE event AS SELECT * FROM original_event; INSERT INTO event SELECT * FROM original_event;');
    const before = f.db.query('SELECT * FROM part ORDER BY id').all();
    const eventsBefore = f.db.query('SELECT * FROM event ORDER BY id').all();
    expect(() => cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic', apply: true, sessionStopped: true,
      backupPath: f.backup })).toThrow('Row conflict');
    expect(f.db.query('SELECT * FROM part ORDER BY id').all()).toEqual(before);
    expect(f.db.query('SELECT * FROM event ORDER BY id').all()).toEqual(eventsBefore);
  } finally { f.close(); }
});

test('default backup is generated outside repository and preview never creates a missing source', () => {
  const f = fixture();
  try {
    const report = cleanHistory({ dbPath: f.file, sessionID: 'ses_synthetic', apply: true, sessionStopped: true });
    expect(report.backupPath.startsWith(f.file + '.pruner-')).toBe(true);
    expect(statSync(report.backupPath).mode & 0o777).toBe(0o600);
    expect(runCLI(['--db', join(f.root, 'missing.sqlite'), '--session', 'ses_synthetic']).status).not.toBe(0);
  } finally { f.close(); }
});
