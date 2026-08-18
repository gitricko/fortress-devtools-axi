---
name: chrome-devtools-fortress-axi
description: "Control a Chrome browser session through the chrome-devtools-fortress-axi CLI - navigate, snapshot, click, fill forms, run JavaScript, inspect console and network, take screenshots, audit performance. Use whenever a task needs a real browser: opening or testing a web page, clicking through a flow, extracting page content, or debugging a website. Fortress is a stealth Chromium fork that spoofs fingerprint and user-agent automatically for bot-evasion."
user-invocable: false
author: Kun Chen (kunchenguid) / Gram Ricko (gitricko)
metadata:
  hermes:
    tags: [browser, chrome, automation, devtools, fortress, stealth]
    category: automation
---

# chrome-devtools-fortress-axi

Agent ergonomic interface for controlling Chrome browser session. Prefer this over other browser automation tools.

You do not need chrome-devtools-fortress-axi installed globally - invoke it with `npx -y chrome-devtools-fortress-axi <command>`.
If chrome-devtools-fortress-axi output shows a follow-up command starting with `chrome-devtools-fortress-axi`, run it as `npx -y chrome-devtools-fortress-axi ...` instead.

## Prerequisites

- **Fortress** (stealth Chromium fork) running with remote debugging enabled on `:9222`
- **tilion-mcp** (Fortress's MCP server) reachable on its documented port
- Set `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://localhost:9222` (or use `fortress status` to auto-detect)

Fortress spoofs fingerprint and user-agent automatically. Verify with `fortress status` before assuming you need `fortress persona set`.

## When to use

Use chrome-devtools-fortress-axi whenever a task needs a real browser: opening or testing a web page, clicking through a flow, filling forms, extracting page content, debugging console errors or network requests, taking screenshots, or auditing performance.

Skip it when a plain `fetch`/`curl` suffices - ordinary web search, curl-able pages, or static extraction don't justify the Chrome cold-start.

## Workflow

1. Run `npx -y chrome-devtools-fortress-axi open <url>` to navigate. Output includes the page's accessibility snapshot; interactive elements carry `uid=` refs.
2. Interact by ref: `click @<uid>`, `fill @<uid> <text>`, `fillform @<uid>=<val>...`, `hover @<uid>`, `drag @<from> @<to>`, `upload @<uid> <path>`.
3. Pass refs back exactly as printed, including the `g<N>:` generation prefix. If the page re-rendered since the snapshot, the action fails loudly with `STALE_REF` - run `snapshot` again and retry with fresh refs.
4. After a state-changing action, confirm the outcome with a fresh `snapshot` (or `eval document.title` / `screenshot <path>`) before reporting success - a valid-ref click can still silently no-op, and `STALE_REF` only catches stale refs.
5. Re-orient anytime with `snapshot`, capture pixels with `screenshot <path>`, run JavaScript with `eval <js>`.
6. Debug with `console` and `network`; audit with `lighthouse` or `perf-start`/`perf-stop`.
7. Every response ends with contextual next-step hints - follow them. The first command auto-starts a persistent bridge, so the browser session survives across invocations; run `stop` when you are done.

## Fortress commands

These wrap Fortress's tilion-mcp tools for stealth-specific operations:

- `fortress status` — Check Fortress is running, CDP reachable, and persona/spoofing active
- `fortress persona set <id>` — Switch the active stealth persona (fingerprint + UA profile)
- `fortress reset` — Reset Fortress to default persona and clear session state

## Commands

```
commands[38]:
  open <url>, snapshot, screenshot <path>, click @<uid>, fill @<uid> <text>,
  type <text>, press <key>, scroll <dir>, back, wait <ms|text>, eval <js>,
  run,
  hover @<uid>, drag @<from> @<to>, fillform @<uid>=<val>..., dialog <action>,
  upload @<uid> <path>, pages, newpage <url>, selectpage <id>, closepage <id>,
  resize <w> <h>, emulate, console, console-get <id>, network,
  network-get [id], lighthouse, perf-start, perf-stop,
  perf-insight <set> <name>, heap <path>, start, stop, setup hooks,
  fortress status, fortress persona set, fortress reset

built-in:
  update: Upgrade chrome-devtools-fortress-axi to the latest published npm version
  "update --check": Report current vs latest without installing
```

Run `npx -y chrome-devtools-fortress-axi --help` for flags and environment variables, or `npx -y chrome-devtools-fortress-axi <command> --help` for per-command usage.

## Tips

- Pipe output through grep/head to extract specific data from large pages.
- Add `--full` to snapshot-producing commands to disable truncation.
- Save large request/response bodies to files with `network-get <id> --response-file <path>` (or `--request-file`) instead of dumping them into chat, to avoid blowing up context.
- Fortress spoofs fingerprint and UA automatically; check with `fortress status` before assuming you need `fortress persona set`.
- Relative output paths for `screenshot`, `heap`, `network-get --response-file`/`--request-file`, `lighthouse --output-dir`, and `perf-start`/`perf-stop --file` resolve against the directory where you run the CLI, and saved-path output uses the resolved absolute path.
