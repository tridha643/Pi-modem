# Pi Modem MCP Extension

This project-local Pi extension exposes Modem's remote MCP server as Pi tools.

## Tools

- `invoke_modem_agent` — calls Modem's `invoke_modem_agent` MCP tool with a complete, self-contained prompt.
- `list_modem_mcp_tools` — lists tools exposed by the Modem MCP server and verifies connectivity.

## Commands

- `/modem-auth` — authorize Pi with Modem via the browser OAuth flow and verify the connection.
- `/modem-reset-auth` — delete saved OAuth credentials so you can authorize again or switch orgs.

## Setup

```bash
cd .pi/extensions/modem-mcp
npm install
cd ../../..
pi
```

Pi auto-discovers `.pi/extensions/modem-mcp/index.ts`. Run `/reload` if Pi is already open.

On the first `/modem-auth` or tool call, the extension opens a browser to authorize `agent:invoke` for the selected Modem organization. OAuth tokens are stored outside the repo at:

```text
~/.pi/agent/modem-mcp-oauth.json
```

## Configuration

Optional environment variables:

- `MODEM_MCP_URL` — defaults to `https://mcp.modem.dev/mcp`.
- `MODEM_MCP_CALLBACK_PORT` — defaults to `17173`.
- `MODEM_MCP_CALLBACK_PATH` — defaults to `/callback`.
- `MODEM_MCP_CALLBACK_URL` — override the full redirect URI if needed.
- `MODEM_MCP_AUTH_TIMEOUT_MS` — defaults to `300000` (5 minutes).
- `MODEM_MCP_TOKEN_FILE` — override the OAuth credential file path.

## Notes

Modem's MCP calls are self-contained. Include all relevant context in each `invoke_modem_agent` prompt instead of relying on previous MCP calls.
