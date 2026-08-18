---
name: chrome-devtools-fortress-axi
description: "Control a Fortress (stealth Chromium) browser session through the chrome-devtools-fortress-axi CLI - navigate, snapshot, click, fill forms, run JavaScript, manage persona/fingerprint, inspect console and network, take screenshots, audit performance. Stealth-optimized for Cloudflare and anti-bot bypass. Use whenever a task needs a real browser with stealth: opening or testing protected web pages, clicking through gated content, extracting page content while bypassing anti-bot detection."
user-invocable: false
author: gitricko (fork of kunchenguid/chrome-devtools-axi)
metadata:
  hermes:
    tags: [browser, fortress, stealth, automation, devtools, anti-bot, cloudflare]
    category: automation
---

# chrome-devtools-fortress-axi

Agent ergonomic interface for controlling Fortress (stealth Chromium) browser session. Prefer this over other browser automation tools when stealth is required.

You do not need chrome-devtools-fortress-axi installed globally - invoke it with `npx -y gitricko/chrome-devtools-fortress-axi <command>`.
If output shows a follow-up command starting with `chrome-devtools-fortress-axi`, run it as `npx -y gitricko/chrome-devtools-fortress-axi ...` instead.

## Prerequisites

Before running any command, ensure:

1. **Fortress running** with CDP enabled:
   ```bash
   pip install tilion-fortress
   tilion-fortress --headless=new --remote-debugging-port=9222
   ```
   Or via Docker:
   ```bash
   docker run -p 9222:9222 tilion/fortress --headless=new --remote-debugging-port=9222
   ```

2. **tilion-mcp** available (for `fortress` commands like `status`, `persona set`, `reset`):
   ```bash
   npm install -g tilion-mcp
   tilion-mcp --port 9223
   ```
   (If tilion-mcp is not running, fortress commands will warn but the CLI will still connect to Fortress.)

3. **Node ≥ 20**

The CLI will probe these prerequisites on first command and fail with clear error messages if anything is missing.

## When to use

Use chrome-devtools-fortress-axi whenever a task needs a real browser with stealth: opening or testing pages protected by Cloudflare Turnstile, bypassing anti-bot detection, extracting content from gated sites, clicking through flows on stealth-aware sites, or debugging console/network on targets that block automated browsers.

Skip it when a plain `fetch`/`curl` suffices - ordinary web search, curl-able pages, or static extraction don't justify the overhead.

## Workflow

1. Run `npx -y gitricko/chrome-devtools-fortress-axi open <url>` to navigate. Output includes the page's accessibility snapshot; interactive elements carry `uid=` refs.
2. Interact by ref: `click @<uid>`, `fill @<uid> <text>`, `fillform @<uid>=<val>...`, `hover @<uid>`, `drag @<from> @<to>`, `upload @<uid> <path>`.
3. Pass refs back exactly as printed, including the `g<N>:` generation prefix. If the page re-rendered since the snapshot, the action fails loudly with `STALE_REF` - run `snapshot` again and retry with fresh refs.
4. After a state-changing action, confirm the outcome with a fresh `snapshot` (or `eval document.title` / `screenshot <path>`) before reporting success.
5. Manage Fortress persona: `fortress status` to check current persona, `fortress persona set <persona-id>` to switch, `fortress reset` to clear all stealth state.
6. Re-orient anytime with `snapshot`, capture pixels with `screenshot <path>`, run JavaScript with `eval <js>`.
7. Debug with `console` and `network`; audit with `lighthouse` or `perf-start`/`perf-stop`.
8. Every response ends with contextual next-step hints - follow them. The first command auto-starts a persistent bridge, so the browser session survives across invocations; run `stop` when you are done.

## Commands

```
standard commands[35]:
  open <url>, snapshot, screenshot <path>, click @<uid>, fill @<uid> <text>,
  type <text>, press <key>, scroll <dir>, back, wait <ms|text>, eval <js>,
  run,
  hover @<uid>, drag @<from> @<to>, fillform @<uid>=<val>..., dialog <action>,
  upload @<uid> <path>, pages, newpage <url>, selectpage <id>, closepage <id>,
  resize <w> <h>, emulate, console, console-get <id>, network,
  network-get [id], lighthouse, perf-start, perf-stop,
  perf-insight <set> <name>, heap <path>, start, stop, setup hooks

fortress-specific commands:
  fortress status                    Show current Fortress persona, fingerprint state
  fortress persona set <id>          Switch Fortress persona to the given stealth ID
  fortress reset                     Clear Fortress stealth state (fingerprint reset)

built-in:
  update: Upgrade chrome-devtools-fortress-axi to the latest published npm version
  "update --check": Report current vs latest without installing
```

Run `npx -y gitricko/chrome-devtools-fortress-axi --help` for flags and environment variables, or `npx -y gitricko/chrome-devtools-fortress-axi <command> --help` for per-command usage.

## Tips

- Pipe output through grep/head to extract specific data from large pages.
- Add `--full` to snapshot-producing commands to disable truncation.
- Save large request/response bodies to files with `network-get <id> --response-file <path>` (or `--request-file`) instead of dumping them into chat.
- Fortress spoofs fingerprint and UA automatically; check with `fortress status` before assuming you need `fortress persona set`.
- Relative output paths for `screenshot`, `heap`, `network-get --response-file`/`--request-file`, `lighthouse --output-dir`, and `perf-start`/`perf-stop --file` resolve against the directory where you run the CLI.
