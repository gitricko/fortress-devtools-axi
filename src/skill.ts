import { HOME_DESCRIPTION, TOP_HELP } from "./cli.js";

// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "needs a real browser" intents.
export const SKILL_DESCRIPTION =
  "Control a Chrome browser session through the fortress-devtools-axi CLI - navigate, snapshot, " +
  "click, fill forms, run JavaScript, inspect console and network, take screenshots, audit " +
  "performance. Use whenever a task needs a real browser: opening or testing a web page, " +
  "clicking through a flow, extracting page content, or debugging a website. Fortress is a stealth " +
  "Chromium fork that spoofs fingerprint and user-agent automatically for bot-evasion.";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Extract the project-owned `commands[N]:` block from top-level help.
 * SDK built-in commands are documented separately in the skill body because
 * runAxiCli appends them at runtime.
 */
export function extractCommandsBlock(): string {
  const match = TOP_HELP.match(/^(commands\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error("Could not find commands block in TOP_HELP");
  }
  return match[1].trimEnd();
}

const SDK_BUILT_IN_COMMANDS_BLOCK = `built-in:
  update: Upgrade fortress-devtools-axi to the latest published npm version
  "update --check": Report current vs latest without installing`;

/**
 * Render the installable SKILL.md for the fortress-devtools-axi skill. The body is
 * built from the same shared guidance the CLI prints (home description and
 * top-level help) plus documented SDK built-ins, rewriting invocations to
 * non-interactive `npx -y fortress-devtools-axi ...` so the CLI comes along on
 * demand.
 *
 * @returns full SKILL.md contents including YAML frontmatter
 */
// Extended frontmatter consumed by harnesses that support it (e.g. Hermes
// Agent reads author and metadata.hermes for first-class skill listings);
// harnesses that don't, like Claude Code, ignore unknown fields.
export const SKILL_AUTHOR = "Kun Chen (kunchenguid) / Gram Ricko (gitricko)";
export const SKILL_HERMES_TAGS = [
  "browser",
  "chrome",
  "automation",
  "devtools",
  "fortress",
  "stealth",
] as const;
export const SKILL_HERMES_CATEGORY = "automation";

export function createSkillMarkdown(): string {
  return `---
name: fortress-devtools-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${SKILL_HERMES_TAGS.join(", ")}]
    category: ${SKILL_HERMES_CATEGORY}
---

# fortress-devtools-axi

${HOME_DESCRIPTION}

You do not need fortress-devtools-axi installed globally - invoke it with \`npx -y fortress-devtools-axi <command>\`.
If fortress-devtools-axi output shows a follow-up command starting with \`fortress-devtools-axi\`, run it as \`npx -y fortress-devtools-axi ...\` instead.

## Prerequisites

- **Fortress** (stealth Chromium fork) running with remote debugging enabled on \`:9222\`
- **tilion-mcp** (Fortress's MCP server) reachable on its documented port
- Set \`CHROME_DEVTOOLS_AXI_BROWSER_URL=http://localhost:9222\` (or use \`fortress status\` to auto-detect)

Fortress spoofs fingerprint and user-agent automatically. Verify with \`fortress status\` before assuming you need \`fortress persona set\`.

## When to use

Use fortress-devtools-axi whenever a task needs a real browser: opening or testing a web page, clicking through a flow, filling forms, extracting page content, debugging console errors or network requests, taking screenshots, or auditing performance.

Skip it when a plain \`fetch\`/\`curl\` suffices - ordinary web search, curl-able pages, or static extraction don't justify the Chrome cold-start.

## Workflow

1. Run \`npx -y fortress-devtools-axi open <url>\` to navigate. Output includes the page's accessibility snapshot; interactive elements carry \`uid=\` refs.
2. Interact by ref: \`click @<uid>\`, \`fill @<uid> <text>\`, \`fillform @<uid>=<val>...\`, \`hover @<uid>\`, \`drag @<from> @<to>\`, \`upload @<uid> <path>\`.
3. Pass refs back exactly as printed, including the \`g<N>:\` generation prefix. If the page re-rendered since the snapshot, the action fails loudly with \`STALE_REF\` - run \`snapshot\` again and retry with fresh refs.
4. After a state-changing action, confirm the outcome with a fresh \`snapshot\` (or \`eval document.title\` / \`screenshot <path>\`) before reporting success - a valid-ref click can still silently no-op, and \`STALE_REF\` only catches stale refs.
5. Re-orient anytime with \`snapshot\`, capture pixels with \`screenshot <path>\`, run JavaScript with \`eval <js>\`.
6. Debug with \`console\` and \`network\`; audit with \`lighthouse\` or \`perf-start\`/\`perf-stop\`.
7. Every response ends with contextual next-step hints - follow them. The first command auto-starts a persistent bridge, so the browser session survives across invocations; run \`stop\` when you are done.

## Fortress commands

These wrap Fortress's tilion-mcp tools for stealth-specific operations:

- \`fortress status\` — Check Fortress is running, CDP reachable, and persona/spoofing active
- \`fortress persona set <id>\` — Switch the active stealth persona (fingerprint + UA profile)
- \`fortress reset\` — Reset Fortress to default persona and clear session state

## Commands

\`\`\`
${extractCommandsBlock()}

${SDK_BUILT_IN_COMMANDS_BLOCK}
\`\`\`

Run \`npx -y fortress-devtools-axi --help\` for flags and environment variables, or \`npx -y fortress-devtools-axi <command> --help\` for per-command usage.

## Tips

- Pipe output through grep/head to extract specific data from large pages.
- Add \`--full\` to snapshot-producing commands to disable truncation.
- Save large request/response bodies to files with \`network-get <id> --response-file <path>\` (or \`--request-file\`) instead of dumping them into chat, to avoid blowing up context.
- Fortress spoofs fingerprint and UA automatically; check with \`fortress status\` before assuming you need \`fortress persona set\`.
- Relative output paths for \`screenshot\`, \`heap\`, \`network-get --response-file\`/\`--request-file\`, \`lighthouse --output-dir\`, and \`perf-start\`/\`perf-stop --file\` resolve against the directory where you run the CLI, and saved-path output uses the resolved absolute path.
`;
}
