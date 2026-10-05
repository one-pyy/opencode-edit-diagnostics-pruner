import path from 'node:path';

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function absolute(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) {
    return `windows:${path.win32.normalize(value).replaceAll('\\', '/').replace(/^[A-Z]:/, drive => drive.toLowerCase())}`;
  }
  if (value.startsWith('/')) return `posix:${path.posix.normalize(value)}`;
  return null;
}

function resolveFile(value, directory) {
  const base = absolute(directory);
  if (base?.startsWith('posix:')) {
    if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return null;
    // POSIX tools treat drive-looking arguments as relative filenames.
    return absolute(path.posix.isAbsolute(value) ? value : path.posix.join(directory, value));
  }
  if (base?.startsWith('windows:') && typeof value === 'string'
    && /^[\\/]/.test(value) && !/^\\\\[^\\]+\\[^\\]+/.test(value)) return null;
  const direct = absolute(value);
  if (direct) return direct;
  if (typeof value !== 'string' || !value || value.includes('\0') || /^[a-z]:/i.test(value)) return null;
  if (!base) return null;
  if (base.startsWith('windows:')) {
    // A root-relative Windows path has an unresolved drive; preserve everything.
    if (/^[\\/]/.test(value)) return null;
    return absolute(path.win32.resolve(directory, value));
  }
  if (value.includes('\\')) return null;
  return absolute(path.posix.resolve(directory, value));
}

function editedPaths(tool, args, metadata, directory) {
  if (tool === 'edit' || tool === 'write') {
    const file = isRecord(args) ? resolveFile(args.filePath, directory) : null;
    return file ? new Set([file]) : null;
  }
  if (tool !== 'apply_patch' || !Array.isArray(metadata.files) || !metadata.files.length) return null;
  const files = new Set();
  for (const entry of metadata.files) {
    if (!isRecord(entry) || !['add', 'update', 'delete', 'move'].includes(entry.type)) return null;
    const original = absolute(entry.filePath);
    if (!original) return null;
    files.add(original);
    if (entry.type !== 'move' && entry.movePath !== undefined) return null;
    if (entry.type === 'move') {
      const destination = absolute(entry.movePath);
      if (!destination) return null;
      files.add(destination);
    }
  }
  return files;
}

export function pruneDiagnostics(tool, args, metadata, directory) {
  const unchanged = { metadata, removedFiles: 0 };
  if (!isRecord(metadata) || !isRecord(metadata.diagnostics)) return unchanged;
  const edited = editedPaths(tool, args, metadata, directory);
  if (!edited) return unchanged;
  const kept = [];
  let removedFiles = 0;
  for (const [key, value] of Object.entries(metadata.diagnostics)) {
    const normalized = absolute(key);
    if (normalized && !edited.has(normalized)) removedFiles++;
    else kept.push([key, value]);
  }
  if (!removedFiles) return unchanged;
  return { metadata: { ...metadata, diagnostics: Object.fromEntries(kept) }, removedFiles };
}
