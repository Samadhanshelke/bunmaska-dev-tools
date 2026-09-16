# Commit Suggest

A Bunmaska desktop app that reads your git working tree and suggests commit messages.

## Why

You finished two unrelated things in one sitting — OTP fix and chat pagination — and now you’re staring at a dirty tree wondering whether to squash them or split. Commit Suggest clusters the diff into logical changes and offers:

- **One change** → one message  
- **N changes** → **N + 1** messages: one combined umbrella, plus one message per change

## Run

```bash
bun install
bun run dev
```

- **Open repo** — pick a git root
- **Scan changes** — re-read `git status` + diff
- **Copy** — put a suggestion on the clipboard
- **Shortcut** — `⌘⇧M` (macOS) / `Ctrl⇧M` (elsewhere)
- **Tray** — stays around after the window closes

## Example

| Working tree | Suggestions |
| --- | --- |
| OTP failure fix only | `fix: otp failure` |
| OTP fix + chat pagination | `chore: fix otp failure and add pagination to chat` · `fix: otp failure` · `feat: add pagination to chat` |

Clustering is heuristic (path segments + diff keywords). It’s a nudge, not a mind reader — tweak the message before you commit.

## Build

```bash
bun run build
```

## Stack

[Bunmaska](https://bunmaska.org/) · Bun · system WebKit · `git`
