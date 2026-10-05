#!/usr/bin/env bun
import { cleanHistory } from './history-db.mjs';

const help = `Usage: bun history.mjs --db /absolute/database.sqlite (--session SESSION | --all)
  [--apply --session-stopped] [--backup /outside/repository/full-backup.sqlite | --no-backup]
  [--progress]

Default: read-only preview, JSON report. No implicit database or session discovery.
Apply: stop the OpenCode host first, then explicitly assert --session-stopped.
Full online backup + quick_check precede one atomic transaction unless --no-backup is explicit.
Backup defaults to a unique sibling of the source database, outside this repository.
Existing backup destinations are refused. No VACUUM is run.
Counts include stored part and event copies; bytes are logical JSON bytes, not disk space.
--all uses one full backup and one transaction, deferring sessions with pending/running tools.
Progress goes to stderr; stdout remains the JSON report. Enabled automatically on terminals.
`;

function options(args) {
  const result = {};
  const seen = new Set();
  const values = { '--db': 'dbPath', '--session': 'sessionID', '--backup': 'backupPath' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`);
    seen.add(arg);
    if (arg === '--apply') result.apply = true;
    else if (arg === '--all') result.all = true;
    else if (arg === '--progress') result.progress = true;
    else if (arg === '--no-backup') result.noBackup = true;
    else if (arg === '--session-stopped') result.sessionStopped = true;
    else if (Object.hasOwn(values, arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      result[values[arg]] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.backupPath && !result.apply) throw new Error('--backup requires --apply');
  return result;
}

function showProgress({ stage, completed, total }) {
  if (stage === 'sessions') {
    if (!process.stderr.isTTY && completed !== 0 && completed !== total && completed % 100 !== 0) return;
    const ratio = total ? completed / total : 1;
    const filled = Math.floor(ratio * 24);
    const line = `[${'#'.repeat(filled)}${'-'.repeat(24 - filled)}] ${completed}/${total} ${(ratio * 100).toFixed(1)}%`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}${completed === total ? '\n' : ''}` : `${line}\n`);
  } else {
    const labels = { backup: 'Creating and validating full database backup...', commit: 'Committing transaction...', done: 'Complete.' };
    process.stderr.write(`${labels[stage]}\n`);
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log(help);
  else {
    const { progress, ...input } = options(args);
    console.log(JSON.stringify(cleanHistory({ ...input,
      onProgress: progress || process.stderr.isTTY ? showProgress : undefined }), null, 2));
  }
} catch (error) {
  console.error(`\nCleanup refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
