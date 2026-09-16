# Toolkit

One Bunmaska desktop app with two local tools in a left sidebar:

- **Portkill** — list listening TCP ports and free them
- **Commit Suggest** — suggest commit messages from your dirty git tree

## How Commit Suggest works

**With a free [Groq](https://console.groq.com/keys) API key** (recommended): the app sends your local git diff to Groq’s free Llama model and asks for conventional commit messages. Removals/fixes are described accurately (e.g. removing a role → `refactor: remove client role from admin dashboard`, not a bogus “add search”).

**Without a key**: falls back to path/keyword heuristics (weaker — can misfire).

Rules either way: return **one** conventional commit message that summarizes what changed.

### Setup Groq (free)

1. Create a key at [console.groq.com/keys](https://console.groq.com/keys)
2. In Toolkit → **Commit Suggest** → **AI key** → paste → **Save**
3. **Scan changes**

The key is stored only in local app prefs. Diff text is sent to Groq when you scan.

## Run

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
