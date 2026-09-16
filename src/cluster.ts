import type { ChangedFile } from './git';

export type ChangeGroup = {
  id: string;
  /** Human label for the cluster, e.g. "otp", "chat pagination" */
  label: string;
  files: ChangedFile[];
  additions: number;
  deletions: number;
};

const NOISE_SEGMENTS = new Set([
  'src',
  'app',
  'apps',
  'lib',
  'libs',
  'packages',
  'pkg',
  'internal',
  'cmd',
  'web',
  'server',
  'client',
  'frontend',
  'backend',
  'api',
  'core',
  'common',
  'shared',
  'utils',
  'util',
  'helpers',
  'components',
  'hooks',
  'pages',
  'views',
  'routes',
  'controllers',
  'services',
  'models',
  'types',
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  'spec',
  'fixtures',
  'public',
  'assets',
  'static',
  'styles',
  'css',
  'dist',
  'build',
  'node_modules',
]);

const EXT_STRIP = /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|java|kt|swift|rb|php|vue|svelte|css|scss|sass|less|html|md|json|yml|yaml|toml|sql)$/i;

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function stem(filename: string): string {
  return filename.replace(EXT_STRIP, '');
}

/** Turn kebab/snake/camel into spaced words. */
export function humanizeToken(raw: string): string {
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Pick a feature key used for clustering.
 * Prefers the first meaningful path segment; falls back to file stem.
 */
export function featureKey(path: string): string {
  const parts = path.split('/').filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase();
    if (NOISE_SEGMENTS.has(lower)) continue;
    if (/^v?\d+(\.\d+)*$/.test(lower)) continue;
    return lower;
  }
  const file = stem(basename(path)).toLowerCase();
  // index/page/main are weak alone — climb one parent if possible
  if (['index', 'main', 'mod', 'page', 'layout', 'app'].includes(file)) {
    for (let i = parts.length - 2; i >= 0; i--) {
      const lower = parts[i].toLowerCase();
      if (!NOISE_SEGMENTS.has(lower)) return lower;
    }
  }
  return file || 'misc';
}

/**
 * Refine a group's label using path + diff keywords when possible.
 */
function refineLabel(key: string, files: ChangedFile[]): string {
  const text = files
    .map((f) => `${f.path}\n${f.excerpt}`)
    .join('\n')
    .toLowerCase();

  const hints: Array<[RegExp, string]> = [
    [/\botp\b/, 'otp'],
    [/\bpagination\b|\bpaginate\b|\bpageSize\b|\bcursor\b/, 'pagination'],
    [/\bauth(enticat|oris)?\b|\blogin\b|\bsign[- ]?in\b/, 'auth'],
    [/\bchat\b|\bmessage(s)?\b|\bconversation\b/, 'chat'],
    [/\bpayment\b|\bstripe\b|\bbilling\b/, 'payments'],
    [/\bnotif(y|ication)?\b/, 'notifications'],
    [/\bupload\b|\bmultipart\b/, 'uploads'],
    [/\bsearch\b|\belastic\b/, 'search'],
    [/\bcache\b|\bredis\b/, 'cache'],
    [/\bwebsocket\b|\bsocket\.io\b/, 'realtime'],
    [/\bemail\b|\bsmtp\b/, 'email'],
    [/\btest(s)?\b|\bspec\b/, 'tests'],
  ];

  const found: string[] = [];
  for (const [re, label] of hints) {
    if (re.test(text) && !found.includes(label)) found.push(label);
  }

  const base = humanizeToken(key);
  if (found.length === 0) return base;

  // Prefer compound when key is generic and we found a better noun
  if (['misc', 'index', 'app', 'utils', 'util', 'shared', 'common'].includes(base)) {
    return found.slice(0, 2).join(' ');
  }

  // Attach distinctive hint not already in the key
  for (const h of found) {
    if (!base.includes(h)) return `${base} ${h}`.trim();
  }
  return base;
}

function slugId(label: string, index: number): string {
  const slug = label.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'change';
  return `${slug}-${index}`;
}

/**
 * Cluster changed files into logical change groups.
 * Same feature key → same group. Singleton groups that share a parent
 * directory with another singleton may be left separate (intentional).
 */
export function clusterChanges(files: ChangedFile[]): ChangeGroup[] {
  if (!files.length) return [];

  const buckets = new Map<string, ChangedFile[]>();
  for (const file of files) {
    const key = featureKey(file.path);
    const list = buckets.get(key) ?? [];
    list.push(file);
    buckets.set(key, list);
  }

  // Merge tiny leftover keys that share a common parent with a larger bucket
  // only when both are size-1 and paths share 2+ segments — keep simple: no merge.

  const groups: ChangeGroup[] = [];
  let i = 0;
  for (const [key, groupFiles] of [...buckets.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const label = refineLabel(key, groupFiles);
    const additions = groupFiles.reduce((s, f) => s + f.additions, 0);
    const deletions = groupFiles.reduce((s, f) => s + f.deletions, 0);
    groups.push({
      id: slugId(label, i++),
      label,
      files: groupFiles.sort((a, b) => a.path.localeCompare(b.path)),
      additions,
      deletions,
    });
  }

  return groups;
}
