# google-workspace-mcp

Doctrine skill for working with Google Workspace from PAVE through the **Gemini
CLI extension's local MCP server** (`gemini-cli-extensions/workspace` v0.0.8),
republished by a loopback bridge as `mcp_mcp-127-0-0-1_*` tools.

Its payload is [`SKILL.md`](SKILL.md) — field-tested operational knowledge for
the Google Workspace MCP bridge — plus the code that makes the install
repeatable:

| Path | Purpose |
|---|---|
| [`bridge/google-workspace-bridge.mjs`](bridge/google-workspace-bridge.mjs) | Republish the stdio server as Streamable HTTP on `127.0.0.1:4318` |
| [`bridge/google-workspace-bridge-start.sh`](bridge/google-workspace-bridge-start.sh) | Idempotent launcher with the 4-scope default |
| [`scripts/save-creds.cjs`](scripts/save-creds.cjs) | Store the credentials blob without `/dev/tty` |
| [`probe/google-workspace-probe.mjs`](probe/google-workspace-probe.mjs) | Token-safe JSON-RPC probe, bridge and stdio modes |

## Install

```bash
pave install johnmak101-ops/openpave-google-workspace-mcp
```

Then read the doctrine from any PAVE session:

```
skill_docs(skill="google-workspace-mcp")
```

The upstream source is forked at
[`johnmak101-ops/workspace`](https://github.com/johnmak101-ops/workspace).
Clone the upstream directly if you do not need the fork:

```bash
git clone --depth 1 https://github.com/gemini-cli-extensions/workspace.git
```

## Why a bridge

PAVE registers MCP servers by URL. The Google Workspace extension's server
speaks MCP over stdio only. The bridge is not optional:

```
Google Cloud <--HTTPS--> Cloud Function <--HTTPS--> MCP server (stdio)
                                                       |
                                                       | stdio
                                                       v
                                                   bridge
                                                       |
                                                       | HTTP 127.0.0.1:4318
                                                       v
                                                   PAVE agent
```

Default result: **4 OAuth scopes and 38 tools** for Gmail, Drive, Docs, and
Calendar, plus time and auth utilities.

## Scope ceiling

Google blocks the upstream shared OAuth client when it requests 5 or more
scopes. The tested ladder is 2 scopes (24 tools), 3 (30 tools), 4 (38 tools),
then blocked. Do not request a fifth scope with the shared client. Host your own
OAuth client and Cloud Function to go further. See SKILL.md §2.2.

## Security

- The default tools can send and permanently delete mail, trash every Drive
  file, delete Doc content, and delete calendar events.
- Prompt injection through email or documents is a real risk. Use a secondary
  Google account.
- The upstream shared client sends your refresh token to
  `https://google-workspace-extension.geminicli.com` at sign-in and roughly
  hourly. If that is unacceptable, self-host the OAuth client and Cloud
  Function.
- Every agent in the PAVE instance can call a registered MCP server.

## No formatting skill

**This skill has no formatting skill.** It ships no converter, renderer,
template, or styling layer.

- `docs.formatText` applies limited text formatting to an existing Doc; it does
  not lay out or brand a document.
- There is no PDF/DOCX/XLSX renderer in the 38-tool surface.
- `docs.create`, `docs.writeText`, and `docs.replaceText` write text content.

Produce formatted output with a dedicated formatting skill (for example
`openpave-pdf` or `openpave-deck`), then store or move the finished artifact
with the Drive tools.

## Relationship to other Google skills

There are three unrelated Google integrations in this account:

| Skill | Auth model | This doctrine applies? |
|---|---|---|
| `google-workspace-mcp` (this repo) | Gemini CLI extension + shared Cloud Function | — |
| `google_workspace_mcp` (Python fork) | Its own OAuth app and HTTP transport | No |
| `google-workspace-api-skill` | Local REST API calls | No |

Credentials are **not interchangeable**. Each uses a different OAuth client
registration. Never paste a token or client secret from one into another.

## License

MIT
