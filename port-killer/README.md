# Portkill

A small Bunmaska desktop app that lists listening TCP ports and lets you kill the process holding one.

## Why

`EADDRINUSE` usually means an old Node/Vite/Docker process is still bound to a port. Portkill shows who owns each listener and frees it in one click.

## Run

```bash
bun install
bun run dev
```

- **Refresh** — rescan with `lsof`
- **Kill** — `SIGTERM`
- **Force** — `SIGKILL`
- **Copy** — copy a `kill` command
- **Auto** — refresh every 3s
- **Shortcut** — `⌘⇧K` (macOS) / `Ctrl⇧K` (elsewhere)
- **Tray** — stays around after the window closes

## Build

```bash
bun run build
```

## Stack

[Bunmaska](https://bunmaska.org/) · Bun · system WebKit · `lsof`
