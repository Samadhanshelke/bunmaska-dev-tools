export type PortEntry = {
  pid: number;
  port: number;
  address: string;
  command: string;
  user: string;
  name: string;
};

const KNOWN_PORTS: Record<number, string> = {
  80: 'HTTP',
  443: 'HTTPS',
  3000: 'Dev server',
  3001: 'Dev server',
  4000: 'Dev server',
  4200: 'Angular',
  5000: 'Dev server',
  5173: 'Vite',
  5432: 'PostgreSQL',
  5672: 'RabbitMQ',
  6379: 'Redis',
  8000: 'Dev server',
  8080: 'HTTP',
  8888: 'Jupyter',
  9229: 'Node inspector',
  27017: 'MongoDB',
};

/**
 * Friendly label for a port. Uses the real process name when the port is ambiguous
 * (e.g. 8080 is often Node, not Tomcat).
 */
export function knownService(
  port: number,
  processName?: string,
  command?: string,
): string | null {
  const hay = `${processName ?? ''} ${command ?? ''}`.toLowerCase();

  if (/postgres/.test(hay)) return 'PostgreSQL';
  if (/redis/.test(hay)) return 'Redis';
  if (/mongo/.test(hay)) return 'MongoDB';
  if (/rabbit|amqp/.test(hay)) return 'RabbitMQ';
  if (/nginx/.test(hay)) return 'nginx';
  if (/apache|httpd/.test(hay)) return 'Apache';
  if (/tomcat|catalina/.test(hay)) return 'Tomcat';
  if (/jupyter/.test(hay)) return 'Jupyter';
  if (/next-server|next\b/.test(hay)) return 'Next.js';
  if (/vite/.test(hay)) return 'Vite';
  if (/node|bun|deno/.test(hay)) {
    if (port === 9229) return 'Node inspector';
    if (port === 5173) return 'Vite';
    return 'Node';
  }
  if (/python|uvicorn|gunicorn|django|flask/.test(hay)) return 'Python';
  if (/ruby|puma|rails/.test(hay)) return 'Ruby';

  return KNOWN_PORTS[port] ?? null;
}

function parseName(name: string): { address: string; port: number } | null {
  // Examples: *:3000, 127.0.0.1:5173, [::1]:8080
  const v6 = name.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) {
    return { address: v6[1], port: Number(v6[2]) };
  }
  const idx = name.lastIndexOf(':');
  if (idx === -1) return null;
  const address = name.slice(0, idx) || '*';
  const port = Number(name.slice(idx + 1));
  if (!Number.isFinite(port)) return null;
  return { address, port };
}

/** Prefer the most useful bind address when the same pid+port appears twice (IPv4 + IPv6). */
function addressRank(address: string): number {
  const a = address.toLowerCase();
  if (a === '*' || a === '0.0.0.0' || a === '::' || a === '[::]') return 100;
  if (a === '127.0.0.1') return 80;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return 70; // other IPv4
  if (a === '::1') return 40;
  if (a.includes(':')) return 50; // other IPv6
  return 60;
}

function preferEntry(a: PortEntry, b: PortEntry): PortEntry {
  return addressRank(a.address) >= addressRank(b.address) ? a : b;
}

/** Plain-English bind target for the UI. */
export function formatListenAddress(address: string): string {
  const a = address.trim().toLowerCase();
  if (a === '*' || a === '0.0.0.0' || a === '::' || a === '[::]') {
    return 'Anywhere';
  }
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') {
    return 'This Mac only';
  }
  return address;
}

async function processDisplayName(pid: number, command: string): Promise<string> {
  try {
    const proc = Bun.spawn(['ps', '-p', String(pid), '-o', 'comm='], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (text) {
      return text.split('/').pop() || command;
    }
  } catch {
    // fall through
  }
  return command;
}

/** List TCP listeners via lsof field mode (macOS / Linux). */
export async function listListeningPorts(): Promise<PortEntry[]> {
  const proc = Bun.spawn(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcun'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // lsof exits 1 when there are no matching sockets — treat as empty.
  if (code !== 0 && !stdout.trim()) {
    if (code === 1) return [];
    throw new Error(stderr.trim() || `lsof failed with exit ${code}`);
  }

  const entries: PortEntry[] = [];
  let pid = 0;
  let command = '';
  let user = '';

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const key = line[0];
    const value = line.slice(1);
    if (key === 'p') {
      pid = Number(value);
    } else if (key === 'c') {
      command = value;
    } else if (key === 'u') {
      user = value;
    } else if (key === 'n' && pid) {
      const parsed = parseName(value);
      if (!parsed) continue;
      entries.push({
        pid,
        port: parsed.port,
        address: parsed.address,
        command,
        user,
        name: command,
      });
    }
  }

  // One row per process+port. lsof often reports both 127.0.0.1 and ::1.
  const byPidPort = new Map<string, PortEntry>();
  for (const entry of entries) {
    const key = `${entry.pid}:${entry.port}`;
    const prev = byPidPort.get(key);
    byPidPort.set(key, prev ? preferEntry(prev, entry) : entry);
  }

  const enriched: PortEntry[] = [];
  for (const entry of byPidPort.values()) {
    entry.name = await processDisplayName(entry.pid, entry.command);
    entry.address = formatListenAddress(entry.address);
    enriched.push(entry);
  }

  enriched.sort((a, b) => a.port - b.port || a.pid - b.pid);
  return enriched;
}

export type KillResult = { ok: true } | { ok: false; error: string };

const PROTECTED_NAMES = new Set([
  'kernel_task',
  'launchd',
  'WindowServer',
  'loginwindow',
  'SystemUIServer',
  'finder',
  'Finder',
]);

export function isProtectedProcess(
  entry: Pick<PortEntry, 'pid' | 'name' | 'command'>,
): boolean {
  if (entry.pid <= 1) return true;
  if (PROTECTED_NAMES.has(entry.name) || PROTECTED_NAMES.has(entry.command)) {
    return true;
  }
  return false;
}

export async function killProcess(pid: number, force = false): Promise<KillResult> {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, error: 'Refusing to signal an invalid or system PID.' };
  }
  if (pid === process.pid) {
    return { ok: false, error: 'Refusing to kill this app.' };
  }

  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function killCommand(pid: number, force = false): string {
  return force ? `kill -9 ${pid}` : `kill ${pid}`;
}
