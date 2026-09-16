import type { ChangedFile } from './git';
import { clusterChanges, type ChangeGroup } from './cluster';
import type {
  CommitSuggestion,
  CommitType,
  SuggestionResult,
} from './suggest';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_DIFF_CHARS = 20_000;

export type AiSuggestResult = SuggestionResult & {
  source: 'ai' | 'heuristic';
  model?: string;
  warning?: string;
};

const TYPES: CommitType[] = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'style',
  'perf',
  'build',
  'ci',
];

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated]`;
}

/** Compact diff payload for the model — split removed vs added so intent is obvious. */
export function buildDiffPrompt(files: ChangedFile[]): string {
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  const parts: string[] = [
    [
      `OVERVIEW: ${files.length} file(s), +${totalAdd}/-${totalDel} lines.`,
      'Read REMOVED and ADDED separately.',
      'If REMOVED lines are mostly conditions/guards/hide flags (shouldShow, isHidden, screen checks, early returns) and the widget/feature still appears in remaining code, describe the outcome as showing/enabling it more broadly — not removing the feature.',
      'Do not invent a "replace X with Y" story unless both X removal and Y addition are clearly present for that same concept.',
    ].join('\n'),
  ];

  for (const f of files) {
    const lines = (f.excerpt || '').split('\n');
    const removed = lines
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1).trimEnd())
      .filter(Boolean);
    const added = lines
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1).trimEnd())
      .filter(Boolean);

    const chunks: string[] = [
      `FILE: ${f.path}`,
      `STATUS: ${f.status}`,
      `LINE_STATS: +${f.additions}/-${f.deletions}`,
    ];
    if (removed.length) {
      chunks.push('REMOVED:');
      chunks.push(...removed.slice(0, 60).map((l) => `  - ${l}`));
      if (removed.length > 60) chunks.push(`  …(${removed.length - 60} more removed lines)`);
    } else {
      chunks.push('REMOVED: (none in excerpt)');
    }
    if (added.length) {
      chunks.push('ADDED:');
      chunks.push(...added.slice(0, 60).map((l) => `  + ${l}`));
      if (added.length > 60) chunks.push(`  …(${added.length - 60} more added lines)`);
    } else {
      chunks.push('ADDED: (none in excerpt)');
    }
    if (!f.excerpt) {
      chunks.push('(no diff excerpt — untracked or binary)');
    }
    parts.push(chunks.join('\n'));
  }

  return truncate(parts.join('\n\n---\n\n'), MAX_DIFF_CHARS);
}

function parseType(raw: unknown): CommitType {
  const t = String(raw ?? 'chore').toLowerCase().trim() as CommitType;
  return TYPES.includes(t) ? t : 'chore';
}

function normalizeMessage(message: string, type: CommitType): string {
  let m = message.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (!m) return `${type}: update code`;
  // Ensure conventional prefix
  const mLower = m.toLowerCase();
  if (!/^(feat|fix|refactor|docs|test|chore|style|perf|build|ci)(\(.+\))?:/.test(mLower)) {
    m = `${type}: ${m}`;
  }
  // lowercase first letter of subject after type:
  const idx = m.indexOf(':');
  if (idx !== -1 && idx + 2 < m.length) {
    const head = m.slice(0, idx + 1);
    const body = m.slice(idx + 1).trim();
    m = `${head} ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  }
  return m;
}

type AiJson = {
  changes?: Array<{ label?: string; files?: string[]; summary?: string }>;
  suggestions?: Array<{
    kind?: string;
    type?: string;
    message?: string;
    rationale?: string;
    files?: string[];
  }>;
};

function extractJson(text: string): AiJson {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model did not return JSON.');
  }
  return JSON.parse(raw.slice(start, end + 1)) as AiJson;
}

function groupsFromAi(files: ChangedFile[], parsed: AiJson): ChangeGroup[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const changes = parsed.changes ?? [];
  if (!changes.length) {
    return clusterChanges(files);
  }

  const used = new Set<string>();
  const groups: ChangeGroup[] = [];
  let i = 0;
  for (const ch of changes) {
    const paths = (ch.files ?? []).filter((p) => byPath.has(p));
    const groupFiles = paths.length
      ? paths.map((p) => byPath.get(p)!)
      : [];
    if (!groupFiles.length) continue;
    for (const f of groupFiles) used.add(f.path);
    const label = (ch.label || ch.summary || `change ${i + 1}`).toLowerCase().trim();
    groups.push({
      id: `ai-${i}`,
      label,
      files: groupFiles,
      additions: groupFiles.reduce((s, f) => s + f.additions, 0),
      deletions: groupFiles.reduce((s, f) => s + f.deletions, 0),
    });
    i++;
  }

  const leftover = files.filter((f) => !used.has(f.path));
  if (leftover.length) {
    groups.push({
      id: `ai-${i}`,
      label: 'other changes',
      files: leftover,
      additions: leftover.reduce((s, f) => s + f.additions, 0),
      deletions: leftover.reduce((s, f) => s + f.deletions, 0),
    });
  }

  return groups.length ? groups : clusterChanges(files);
}

function suggestionsFromAi(
  files: ChangedFile[],
  groups: ChangeGroup[],
  parsed: AiJson,
): CommitSuggestion[] {
  const raw = parsed.suggestions ?? [];
  const first = raw[0];
  if (!first?.message) {
    throw new Error('Model returned no suggestion.');
  }

  const type = parseType(first.type);
  const message = normalizeMessage(String(first.message), type);

  return [
    {
      id: 'single-0',
      kind: 'single',
      type,
      message,
      groupIds: groups.map((g) => g.id),
      rationale: String(first.rationale ?? 'AI summary of what changed.'),
      files: files.map((f) => f.path),
    },
  ];
}

const SYSTEM_PROMPT = `You write ONE conventional git commit message from a unified diff.

Core job: describe the USER-VISIBLE outcome of the change, not a naive "deleted lines = removed feature" summary.

Grounding rules (must follow):
1. ONLY use facts from REMOVED/ADDED lines. Never invent features that are not in the diff.
2. Distinguish FEATURE removal vs GUARD/CONDITION removal:
   - If a widget/component/feature symbol still remains (render, import, JSX/usage still present) but conditions that HID it are deleted (e.g. shouldShow, isHidden, if (screen === …), early return, visibility flags, route allowlists), the intent is usually to SHOW it more broadly — e.g. "show profile completion widget on all screens".
   - Only say "remove X" when X itself is deleted (component file gone, JSX/usage removed, feature flag fully ripped out) and not merely ungated.
3. Removal ≠ replacement. Say "replace X with Y" only if Y is clearly added as X's substitute.
4. Match scope to the files/paths touched (all screens vs one screen).
5. Prefer refactor/chore for structural UI logic; feat only when something new is introduced; fix for bug fixes.
6. Subject: imperative, short, one message only.

Good examples:
- Deleted hide-on-some-screens conditions; widget JSX still present → "refactor: show profile completion widget on all screens"
- Deleted the profile completion widget component and all usages → "refactor: remove profile completion widget"
- Client role deleted from many files → "refactor: remove client role"
- Client role deleted AND organization role added as substitute → "refactor: replace client role with organization role"

Bad examples (never do these):
- "remove profile completion widget logic" when you only removed visibility/screen checks and the widget still renders
- "replace client with organization" when organization was not added as a replacement
- Naming unrelated features that are not in the diff

Return ONLY valid JSON (no markdown):
{
  "evidence": {
    "removed": "short facts from REMOVED lines",
    "added": "short facts from ADDED lines (or 'nothing material')",
    "still_present": "what feature/UI still remains after the change",
    "outcome": "what users/devs experience now (e.g. widget visible everywhere)",
    "scope": "which areas/files this spans"
  },
  "changes": [
    { "label": "short label", "summary": "one factual sentence", "files": ["path/one.ts"] }
  ],
  "suggestions": [
    {
      "kind": "single",
      "type": "refactor",
      "message": "refactor: show profile completion widget on all screens",
      "rationale": "must match evidence.outcome, not a naive deletion summary",
      "files": ["path/one.ts"]
    }
  ]
}
suggestions must contain exactly one item. message must match evidence.outcome.`;

export async function suggestCommitsWithGroq(
  files: ChangedFile[],
  apiKey: string,
): Promise<AiSuggestResult> {
  if (!files.length) {
    return { groups: [], suggestions: [], source: 'ai', model: GROQ_MODEL };
  }

  const userContent = `Write exactly one commit message for this working-tree diff.

Ask yourself: did we remove a feature, or remove a restriction so something shows/works more broadly?
If visibility/screen guards were deleted but the widget/feature remains, phrase it as show/enable — not remove.

${buildDiffPrompt(files)}`;

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      max_tokens: 800,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Groq API error ${res.status}: ${body.slice(0, 240) || res.statusText}`,
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Groq returned an empty response.');
  }

  const parsed = extractJson(content);
  const groups = groupsFromAi(files, parsed);
  const suggestions = suggestionsFromAi(files, groups, parsed);

  return {
    groups,
    suggestions,
    source: 'ai',
    model: GROQ_MODEL,
  };
}
