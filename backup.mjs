import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = realpathSync(fileURLToPath(new URL('.', import.meta.url)));

export function checkedBackupPath(source, requested) {
  const target = path.resolve(requested);
  const parent = realpathSync(path.dirname(target));
  const canonical = path.join(parent, path.basename(target));
  const relative = path.relative(projectRoot, canonical);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Backup must be outside the plugin repository');
  }
  if (canonical === realpathSync(source)) throw new Error('Backup cannot replace source');
  return canonical;
}

export function backupDatabase(source, requested, { progress = false } = {}) {
  const target = checkedBackupPath(source, requested);
  // Python exclusively creates the destination: existing backups are never overwritten.
  execFileSync('python3', [fileURLToPath(new URL('./backup.py', import.meta.url)), source, target,
    ...(progress ? ['--progress'] : [])],
    { stdio: ['ignore', 'ignore', progress ? 'inherit' : 'pipe'], timeout: 0 });
  if (!statSync(target).isFile() || (statSync(target).mode & 0o777) !== 0o600) {
    throw new Error('Backup file or permissions invalid');
  }
  return target;
}
