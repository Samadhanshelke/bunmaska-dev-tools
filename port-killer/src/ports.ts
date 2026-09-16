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
  3000: 'Next / React / Vite',
  3001: 'Dev server',
  4000: 'Dev server',
  4200: 'Angular',
  5000: 'Flask / Rails / Vite',
  5173: 'Vite',
  5432: 'PostgreSQL',
  5672: 'RabbitMQ',
  6379: 'Redis',
  8000: 'Django / uvicorn',
  8080: 'HTTP alt / Tomcat',
  8888: 'Jupyter',
  9229: 'Node inspector',
  27017: 'MongoDB',
};

export function knownService(port: number): string | null {
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

  const seen = new Set<string>();
  const enriched: PortEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.pid}:${entry.port}:${entry.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entry.name = await processDisplayName(entry.pid, entry.command);
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
