import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type FileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'typechange'
  | 'unknown';

export type ChangedFile = {
  path: string;
  status: FileStatus;
  staged: boolean;
  additions: number;
  deletions: number;
  /** Short textual excerpt from the diff (for heuristics). */
  excerpt: string;
};

export type RepoScan = {
  root: string;
  branch: string;
  dirty: boolean;
  files: ChangedFile[];
};

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export function findGitRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function mapStatus(code: string): FileStatus {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    case '?':
      return 'untracked';
    default:
      return 'unknown';
  }
}

/** Prefer the more “interesting” status when both index and worktree differ. */
function preferStatus(a: FileStatus, b: FileStatus): FileStatus {
  const rank: Record<FileStatus, number> = {
    deleted: 6,
    added: 5,
    renamed: 4,
    copied: 3,
    typechange: 2,
    modified: 1,
    untracked: 1,
    unknown: 0,
  };
  return rank[a] >= rank[b] ? a : b;
}

function parseNumstatLine(line: string): {
  path: string;
  additions: number;
  deletions: number;
} | null {
  // "12\t3\tpath" or "-\t-\tpath" (binary) or rename "12\t3\told => new"
  const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
  if (!m) return null;
  const pathPart = m[3];
  const path = pathPart.includes(' => ')
    ? pathPart.split(' => ').pop()!.trim()
    : pathPart;
  return {
    path,
    additions: m[1] === '-' ? 0 : Number(m[1]),
    deletions: m[2] === '-' ? 0 : Number(m[2]),
  };
}

async function collectDiffExcerpts(
  cwd: string,
  paths: string[],
): Promise<Map<string, string>> {
  const excerpts = new Map<string, string>();
  if (!paths.length) return excerpts;

  // Unstaged + untracked content hints via name-only + limited patch
  const { stdout } = await runGit(cwd, [
    'diff',
    'HEAD',
    '--no-color',
    '--unified=0',
    '--',
    ...paths,
  ]);

  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) {
      excerpts.set(current, buf.slice(0, 40).join('\n'));
    }
    buf = [];
  };

  for (const line of stdout.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const parts = line.split(' ');
      const b = parts[parts.length - 1] ?? '';
      current = b.replace(/^b\//, '');
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith('@@')) {
      buf.push(line);
    }
  }
  flush();
  return excerpts;
}

export async function scanRepo(repoPath: string): Promise<RepoScan> {
  const root = findGitRoot(repoPath);
  if (!root) {
    throw new Error('Not a git repository (no .git found).');
  }

  const branchRes = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRes.code !== 0) {
    throw new Error(branchRes.stderr.trim() || 'Failed to read git branch.');
  }
  const branch = branchRes.stdout.trim() || 'HEAD';

  // Porcelain v1: XY PATH or XY ORIG -> PATH
  const statusRes = await runGit(root, [
    'status',
    '--porcelain=v1',
    '-uall',
    '--ignore-submodules=dirty',
  ]);
  if (statusRes.code !== 0) {
    throw new Error(statusRes.stderr.trim() || 'git status failed.');
  }

  const byPath = new Map<
    string,
    { status: FileStatus; staged: boolean }
  >();

  for (const raw of statusRes.stdout.split('\n')) {
    if (!raw) continue;
    const x = raw[0] ?? ' ';
    const y = raw[1] ?? ' ';
    let pathPart = raw.slice(3);
    if (pathPart.includes(' -> ')) {
      pathPart = pathPart.split(' -> ').pop()!.trim();
    }
    // Untracked: "?? path"
    if (x === '?' && y === '?') {
      byPath.set(pathPart, { status: 'untracked', staged: false });
      continue;
    }
    const stagedCode = x === ' ' || x === '?' ? null : x;
    const workCode = y === ' ' || y === '?' ? null : y;
    const staged = stagedCode !== null;
    const code = workCode ?? stagedCode ?? '?';
    const status = mapStatus(code);
    const prev = byPath.get(pathPart);
    if (prev) {
      byPath.set(pathPart, {
        status: preferStatus(prev.status, status),
        staged: prev.staged || staged,
      });
    } else {
      byPath.set(pathPart, { status, staged });
    }
  }

  const paths = [...byPath.keys()];
  const stats = new Map<string, { additions: number; deletions: number }>();

  if (paths.length) {
    // Staged + unstaged vs HEAD
    const numRes = await runGit(root, [
      'diff',
      'HEAD',
      '--numstat',
      '--',
      ...paths,
    ]);
    for (const line of numRes.stdout.split('\n')) {
      if (!line) continue;
      const parsed = parseNumstatLine(line);
      if (parsed) stats.set(parsed.path, parsed);
    }

    // Untracked files won't appear in diff HEAD — treat whole file later
    for (const p of paths) {
      if (!stats.has(p) && byPath.get(p)?.status === 'untracked') {
        stats.set(p, { additions: 0, deletions: 0 });
      }
    }
  }

  const excerpts = await collectDiffExcerpts(root, paths);

  const files: ChangedFile[] = paths
    .map((path) => {
      const meta = byPath.get(path)!;
      const st = stats.get(path) ?? { additions: 0, deletions: 0 };
      return {
        path,
        status: meta.status,
        staged: meta.staged,
        additions: st.additions,
        deletions: st.deletions,
        excerpt: excerpts.get(path) ?? '',
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    root,
    branch,
    dirty: files.length > 0,
    files,
  };
}
