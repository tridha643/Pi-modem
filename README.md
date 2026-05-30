# Pi Modem MCP Extension

A project-local [Pi](https://pi.dev) extension that exposes Modem's remote MCP server as Pi tools.

## What it adds

- `invoke_modem_agent` — asks Modem's `invoke_modem_agent` MCP tool a self-contained natural-language question.
- `list_modem_mcp_tools` — lists Modem MCP tools and checks connectivity.
- `/modem-auth` — starts/validates browser OAuth authorization for Modem.
- `/modem-reset-auth` — clears saved OAuth credentials.

## Setup

```bash
cd .pi/extensions/modem-mcp
npm install
cd ../../..
pi
```

If Pi is already running, use `/reload` after installing dependencies.

The extension is auto-discovered from:

```text
.pi/extensions/modem-mcp/index.ts
```

OAuth credentials are stored outside the repo at:

```text
~/.pi/agent/modem-mcp-oauth.json
```

## Use

Run `/modem-auth` once, complete the browser consent flow, then ask Pi questions that require Modem. Pi can call `invoke_modem_agent` when it needs Modem customer-feedback data or connected-tool context.

Each Modem MCP call is self-contained, so prompts sent to Modem should include all needed context.

See `.pi/extensions/modem-mcp/README.md` for configuration options.
