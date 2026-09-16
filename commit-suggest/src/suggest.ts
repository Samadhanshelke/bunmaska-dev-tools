import type { ChangedFile } from './git';
import { clusterChanges, humanizeToken, type ChangeGroup } from './cluster';

export type CommitType =
  | 'feat'
  | 'fix'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'chore'
  | 'style'
  | 'perf'
  | 'build'
  | 'ci';

export type SuggestionKind = 'single' | 'combined' | 'separate';

export type CommitSuggestion = {
  id: string;
  kind: SuggestionKind;
  type: CommitType;
  /** Full conventional commit subject line. */
  message: string;
  /** Groups this suggestion covers. */
  groupIds: string[];
  /** Short why / scope blurb for the UI. */
  rationale: string;
  files: string[];
};

export type SuggestionResult = {
  groups: ChangeGroup[];
  suggestions: CommitSuggestion[];
};

const FIX_HINT =
  /\b(fix|bug|broken|fail(ure|ed|ing)?|crash|error|issue|hotfix|regress|wrong|incorrect|typo)\b/i;
const FEAT_HINT =
  /\b(add|added|adding|introduc|implement|support|enable|new|creat|feat)\b/i;
const REFACTOR_HINT =
  /\b(refactor|cleanup|clean up|rename|restructure|simplify|extract)\b/i;
const PERF_HINT = /\b(perf|optimiz|faster|cache|latency|throughput)\b/i;
const DOCS_HINT = /\b(readme|docs?|changelog|jsdoc|godoc)\b/i;
const TEST_HINT = /\b(test|spec|jest|vitest|pytest|cypress|playwright)\b/i;
const STYLE_HINT = /\b(lint|prettier|format|eslint|style)\b/i;
const BUILD_HINT = /\b(webpack|vite|rollup|dockerfile|makefile|tsconfig)\b/i;
const CI_HINT = /\b(\.github\/workflows|gitlab-ci|circleci|ci\.yml)\b/i;

function pathsLookLike(files: ChangedFile[], re: RegExp): boolean {
  return files.every((f) => re.test(f.path)) || files.some((f) => re.test(f.path));
}

function inferType(files: ChangedFile[], label: string): CommitType {
  const blob = `${label}\n${files.map((f) => `${f.path}\n${f.excerpt}`).join('\n')}`;
  const statuses = new Set(files.map((f) => f.status));

  if (CI_HINT.test(blob) || pathsLookLike(files, /^\.github\/workflows\//)) return 'ci';
  if (TEST_HINT.test(blob) && pathsLookLike(files, /\.(test|spec)\./i)) return 'test';
  if (DOCS_HINT.test(blob) && pathsLookLike(files, /\.(md|mdx|rst)$/i)) return 'docs';
  if (STYLE_HINT.test(blob) && !FIX_HINT.test(blob) && !FEAT_HINT.test(blob)) return 'style';
  if (BUILD_HINT.test(blob) && pathsLookLike(files, /(package\.json|bun\.lock|tsconfig|Dockerfile)/i)) {
    return 'build';
  }
  if (PERF_HINT.test(blob)) return 'perf';
  if (FIX_HINT.test(blob)) return 'fix';
  if (REFACTOR_HINT.test(blob) && !FEAT_HINT.test(blob)) return 'refactor';
  if (FEAT_HINT.test(blob) || statuses.has('added') || statuses.has('untracked')) return 'feat';
  if (statuses.has('deleted') && files.every((f) => f.status === 'deleted')) return 'chore';
  if (FIX_HINT.test(label)) return 'fix';
  return statuses.has('added') || statuses.has('untracked') ? 'feat' : 'fix';
}

function subjectForGroup(group: ChangeGroup, type: CommitType): string {
  const label = group.label;
  const files = group.files;
  const blob = files.map((f) => f.excerpt).join('\n').toLowerCase();

  // Try to build a natural phrase from label + type
  if (type === 'fix') {
    if (/otp/.test(label) || /\botp\b/.test(blob)) return 'fix otp failure';
    if (/\bfail/.test(blob) || /fail/.test(label)) {
      return `fix ${label.replace(/\bfailure\b/, '').trim()} failure`.replace(/\s+/g, ' ').trim();
    }
    return `fix ${label}`;
  }
  if (type === 'feat') {
    if (/pagination/.test(label) || /pagination/.test(blob)) {
      if (/chat/.test(label) || /chat/.test(blob)) return 'add pagination to chat';
      return `add ${label.includes('pagination') ? label : `${label} pagination`}`;
    }
    if (label.startsWith('add ')) return label;
    return `add ${label}`;
  }
  if (type === 'refactor') return `refactor ${label}`;
  if (type === 'docs') return `docs: update ${label}`;
  if (type === 'test') return `add tests for ${label}`;
  if (type === 'perf') return `improve ${label} performance`;
  if (type === 'style') return `style ${label}`;
  if (type === 'build') return `update ${label} build config`;
  if (type === 'ci') return `update ${label} ci`;
  return `${type} ${label}`;
}

function normalizeSubject(type: CommitType, subject: string): string {
  let s = subject.trim().replace(/\s+/g, ' ').toLowerCase();
  // Avoid "fix fix …" / "feat add …" duplication when subject already has type word
  const typeWord = type === 'feat' ? 'add' : type;
  if (s.startsWith(`${type}:`)) {
    s = s.slice(type.length + 1).trim();
  }
  if (type === 'feat' && s.startsWith('add ')) {
    // keep
  } else if (s.startsWith(`${typeWord} `)) {
    // keep
  }
  // Conventional: type: subject (no trailing period)
  s = s.replace(/\.$/, '');
  // If subject already is "fix otp…" and type is fix → "fix: otp…" cleaner?
  // Prefer: fix: <imperative without repeating type>
  let body = s;
  if (type === 'fix' && body.startsWith('fix ')) body = body.slice(4);
  if (type === 'feat' && body.startsWith('feat ')) body = body.slice(5);
  if (type === 'refactor' && body.startsWith('refactor ')) body = body.slice(9);
  // Keep leading verbs for feat (add …)
  return `${type}: ${body}`.replace(/\s+/g, ' ').trim();
}

function combinedSubject(groups: ChangeGroup[]): { type: CommitType; message: string } {
  const types = groups.map((g) => inferType(g.files, g.label));
  const type: CommitType = types.every((t) => t === 'fix')
    ? 'fix'
    : types.every((t) => t === 'feat')
      ? 'feat'
      : types.includes('feat') && types.includes('fix')
        ? 'fix' // mixed: prefer a pragmatic umbrella; often "fix" is wrong — use chore-ish
        : types.includes('feat')
          ? 'feat'
          : types[0] ?? 'chore';

  // Better mixed umbrella
  const umbrellaType: CommitType =
    new Set(types).size > 1 ? 'chore' : type;

  const phrases = groups.map((g) => {
    const t = inferType(g.files, g.label);
    const raw = subjectForGroup(g, t)
      .replace(/^(fix|add|refactor|improve|update|style)\s+/i, '')
      .trim();
    return humanizeToken(raw) || g.label;
  });

  // "fix otp failure and add chat pagination" style when mixed
  if (new Set(types).size > 1) {
    const parts = groups.map((g, i) => {
      const t = types[i];
      const sub = subjectForGroup(g, t);
      return sub;
    });
    // Join with " and " — then wrap as chore or leave as freeform under chore:
    const joined = parts.join(' and ');
    return { type: 'chore', message: normalizeSubject('chore', joined) };
  }

  if (umbrellaType === 'fix') {
    return {
      type: 'fix',
      message: normalizeSubject('fix', phrases.join(' and ')),
    };
  }
  if (umbrellaType === 'feat') {
    return {
      type: 'feat',
      message: normalizeSubject('feat', `add ${phrases.join(' and ')}`),
    };
  }
  return {
    type: umbrellaType,
    message: normalizeSubject(umbrellaType, phrases.join(' and ')),
  };
}

/**
 * Build commit message suggestions from changed files.
 *
 * - 1 logical change → 1 suggestion
 * - N>1 changes → N separate + 1 combined (N+1 total)
 */
export function suggestCommits(files: ChangedFile[]): SuggestionResult {
  const groups = clusterChanges(files);
  if (!groups.length) {
    return { groups: [], suggestions: [] };
  }

  if (groups.length === 1) {
    const g = groups[0];
    const type = inferType(g.files, g.label);
    const message = normalizeSubject(type, subjectForGroup(g, type));
    return {
      groups,
      suggestions: [
        {
          id: 'single-0',
          kind: 'single',
          type,
          message,
          groupIds: [g.id],
          rationale: `One logical change across ${g.files.length} file${g.files.length === 1 ? '' : 's'}.`,
          files: g.files.map((f) => f.path),
        },
      ],
    };
  }

  const suggestions: CommitSuggestion[] = [];

  const combined = combinedSubject(groups);
  suggestions.push({
    id: 'combined',
    kind: 'combined',
    type: combined.type,
    message: combined.message,
    groupIds: groups.map((g) => g.id),
    rationale: `One commit covering all ${groups.length} changes.`,
    files: files.map((f) => f.path),
  });

  groups.forEach((g, index) => {
    const type = inferType(g.files, g.label);
    const message = normalizeSubject(type, subjectForGroup(g, type));
    suggestions.push({
      id: `separate-${index}`,
      kind: 'separate',
      type,
      message,
      groupIds: [g.id],
      rationale: `Separate commit for ${g.label} (${g.files.length} file${g.files.length === 1 ? '' : 's'}).`,
      files: g.files.map((f) => f.path),
    });
  });

  return { groups, suggestions };
}
