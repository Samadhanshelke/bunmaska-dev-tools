# Toolkit

A single [Bunmaska](https://bunmaska.org/) desktop app. Two tools share one window and a left sidebar:

- **Portkill** — list listening TCP ports and free the process holding one
- **Commit Suggest** — suggest a conventional commit message from your dirty git tree

## Portkill

Uses `lsof` to show who owns each listener.

- **Filter** — port, process, pid, or command
- **Kill** — `SIGTERM`
- **Force** — `SIGKILL`
- **Copy** — copy a `kill` command
- **Auto** — refresh every 3s

Protected system processes and this app itself cannot be killed from the table.

## Commit Suggest

**With a free [Groq](https://console.groq.com/keys) API key** (recommended): the app sends your local git diff to Groq’s free Llama model and asks for a conventional commit message. Removals and fixes are described as they are (e.g. removing a role → `refactor: remove client role from admin dashboard`, not a bogus “add search”).

**Without a key**: falls back to path/keyword heuristics (weaker — can misfire).

Either way it returns **one** conventional commit message that summarizes what changed.

### Groq setup (free)

1. Create a key at [console.groq.com/keys](https://console.groq.com/keys)
2. Commit Suggest → **AI key** → paste → **Save**
3. **Scan changes**

The key is stored only in local app prefs. Diff text is sent to Groq when you scan.

## Run

From this repo root:

```bash
bun install
bun run dev
```

- Sidebar switches tools
- Shortcut: `⌘⇧T` (macOS) / `Ctrl⇧T` (elsewhere)
- Tray stays after the window closes

## Build

```bash
bun run build
```

## Stack

[Bunmaska](https://bunmaska.org/) · Bun · system WebKit · `lsof` · `git`
