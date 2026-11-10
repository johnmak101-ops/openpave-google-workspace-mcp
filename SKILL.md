# Google Workspace MCP Skill Doctrines (SKILL.md)

Doctrines for working with Google Workspace from PAVE through the **Gemini CLI
extension's local MCP server** (`gemini-cli-extensions/workspace`, v0.0.8),
republished by a loopback bridge as `mcp_mcp-127-0-0-1_*` tools.

Every claim carries a tag. Trust them differently:

| Tag | Meaning |
|---|---|
| `[field-tested 2026-11-05]` | Run end to end on a live PAVE instance in a Debian Docker container (aarch64), Node v22.23.4, playbook revision 2. |
| `[upstream 0.0.8]` | Read from the pinned upstream tree. File paths are cited. |
| `[playbook]` | Stated in revision 2 of the field playbook but not re-run for this repository. |
| `[web]` | From Google or upstream documentation. |
| `[untested]` | No evidence either way. Do not rely on it. |

If you change something in this file, replace blanket dates with per-claim
tags. A single "verified" stamp over unverified material launders guesswork
into fact.

---

## 0. What this skill is — and is not

- Doctrine plus four runnable helpers: a bridge, an idempotent launcher, a
  credential helper, and a diagnostic probe. `SKILL.md` is the entrypoint; the
  code lives in `bridge/`, `scripts/`, and `probe/`.
- **The bridge is not optional.** The upstream server speaks MCP over **stdio
  only**. PAVE registers MCP servers by **URL** only. Nothing connects the two
  without a process between them. `[field-tested 2026-11-05]`
- Default install: **4 OAuth scopes and 38 tools** — Gmail, Drive, Docs,
  Calendar, plus time and auth utilities. `[field-tested 2026-11-05]`
- **The refresh token leaves your machine.** The upstream shared OAuth client
  keeps its client secret on Google's Cloud Function and sends your refresh
  token to `https://google-workspace-extension.geminicli.com` at sign-in and
  again at roughly every hourly refresh. If that is unacceptable, host your own
  OAuth client and Cloud Function (`docs/GCP-RECREATION.md` upstream); that
  path also lifts the 4-scope ceiling. `[field-tested 2026-11-05]`
- **The default tools can destroy data.** `gmail.modify` reads, sends, and
  permanently deletes mail. `drive` reads, moves, renames, and trashes every
  file. `documents` edits and deletes the text of every Google Doc. `calendar`
  creates, changes, and deletes events. Google's consent screen does not say
  "delete" for Gmail; the permission is there. `[playbook]`
- **Prompt injection is a real risk.** An email or document you ask the agent to
  read can contain hidden instructions that make it delete mail or files. Use a
  secondary Google account, not your primary one. `[upstream 0.0.8 — README
  security section]`
- **Credentials do not transfer between Google skills.** The Python
  `google_workspace_mcp` fork (taylorwilsdon), the REST API skill, and this
  extension each use a different OAuth app. Never paste one token or client
  secret into another. `[verified by construction — three different client
  registrations]`
- This doctrine applies **only** to the Gemini CLI extension. It does not
  describe the Python `google_workspace_mcp` server, which has its own
  transport and auth.

---

## 1. Architecture and install

```
Google Cloud  <--HTTPS--  Cloud Function  <--HTTPS--  MCP server (stdio)
                                                            |
                                                            | stdio
                                                            v
                                                      bridge (this skill)
                                                            |
                                                            | HTTP on 127.0.0.1:4318
                                                            v
                                                        PAVE agent
```

`[field-tested 2026-11-05]`

### 1.1 Prerequisites

| Item | Requirement |
|---|---|
| Node.js | Version 20 or higher; tested on v22.23.4 |
| git | Any recent version |
| curl | For health checks |
| A web browser | On any device; it does not need to be the PAVE host |
| A Google account | A secondary account is strongly recommended (see §0) |
| PAVE | With `PAVE_CAPABILITIES_EXPERIMENTAL=true` |

Many containers set `NODE_ENV=production`. That value silently omits
devDependencies and breaks the build. Override it on every install and build
command. `[field-tested 2026-11-05]`

### 1.2 Register the bridge in PAVE

```bash
capabilities_add http://127.0.0.1:4318/mcp
```

Accept the confirmation card. If you do not, nothing is installed.

PAVE derives the entry name from the URL host: `mcp-127-0-0-1`. The name cannot
be changed. Bridged tools are named `mcp_mcp-127-0-0-1_<tool>`, with dots
converted to underscores (for example `mcp_mcp-127-0-0-1_gmail_search`).
`[field-tested 2026-11-05]`

Confirm:

```
capabilities_status mcp-127-0-0-1
```

Expected: `installed`, with 38 bridged tools.

A PAVE session loads its tool list at start. Register the server before you
open the session that will use it, or that session may hold a stale list.
`[playbook]`

### 1.3 R10 first-use gate

Every bridged call is blocked until the instance approves the server. The block
answers:

```
Error: MCP "mcp-127-0-0-1" requires approval on first use (R10 default: ask).
Call the permission tool with action "grant", type "mcp", target:
"mcp:mcp-127-0-0-1"
```

**Do not follow that instruction.** The `permission` tool writes the sandbox
store, not the MCP gate; its `type` list has no `mcp` entry. Edit
`~/.pave/permissions.yaml` directly:

```yaml
permissions:
  mcp:
    allowed:
      - mcp-127-0-0-1
    denied: []
```

Merge this under the existing `permissions:` key; do not create a second one.
Save. Retry. The gate opens immediately; no restart is needed. Use `'*'` only
if every MCP server in the instance should be callable. `[field-tested
2026-11-05]`

### 1.4 Repair versus registration

- A container restart kills the bridge. Start it again with the launcher, then
  call `capabilities_refresh mcp-127-0-0-1` **twice**. The first call fails with
  `Session not found`; the second succeeds. `[field-tested 2026-11-05]`
- Re-run `capabilities_add` only when the registry entry is genuinely missing.
  It is registration, not repair; a transport failure is fixed with a restart
  and a refresh. `[playbook]`
- To remove the entry, use `capabilities_uninstall mcp:127.0.0.1` (§10).
  `[playbook]`

---

## 2. Auth

### 2.1 Why the upstream login command fails in a container

The upstream command is:

```bash
npm run auth-utils -- login
```

It prints an OAuth URL, then reads the pasted credentials from `/dev/tty`. In a
container that read fails:

```
Error: ENXIO: no such device or address, open '/dev/tty'
```

That failure is expected. Do not try to fix it. The URL remains valid, and the
upstream Cloud Function renders the finished credential JSON in the browser in
manual mode. `[field-tested 2026-11-05]`

### 2.2 The consent scope ceiling is 4

Google blocks the upstream shared OAuth client when it requests **5 or more
scopes**. This was not a verdict on one API; it was a count ceiling:

| Scopes requested | Result |
|---|---|
| 2 (`drive`, `gmail.modify`) | granted, 24 tools |
| 3 (+ `documents`) | granted, 30 tools |
| 4 (+ `calendar`) | granted, 38 tools — **default** |
| 5 (+ `spreadsheets`) | blocked |
| 5 (+ `presentations`) | blocked |
| 5 (+ `tasks.readonly`) | blocked |
| 6, one shot | blocked |
| 12, one shot | blocked |

`[field-tested 2026-11-05]`

Do not request a fifth scope with this client. Each block risks Google revoking
the grant you already hold; that revocation did happen during testing. Recovery
is one more sign-in at a passing scope set. The only way past the ceiling is
your own OAuth client, with your account added as a GCP test user (§2.11).

### 2.3 Build the login URL

Add `--force`. When valid credentials are already stored, the login command
prints `Already authenticated` and exits **before** printing a URL. `--force`
makes it print the URL. `[field-tested 2026-11-05]`

```bash
cd "$GWS_ROOT"
GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true \
WORKSPACE_FEATURE_OVERRIDES="chat.read:off,chat.write:off,people.read:off,slides.read:off,sheets.read:off" \
timeout 20 node scripts/auth-utils.js login --force < /dev/null
```

The command prints a URL and then fails on `/dev/tty`. Copy the URL before the
error.

**The overrides value must equal the launcher value.** The URL requests exactly
the scopes those overrides produce. A mismatch makes `AuthManager` delete your
token on the next call. `[upstream 0.0.8 — src/auth/scopes.ts, src/index.ts]`

### 2.4 Check the URL before you use it

```bash
node -e '
const u = process.argv[1];
const p = new URL(u).searchParams;
console.log("scopes:", decodeURIComponent(p.get("scope"))
  .split(" ").map(s => s.replace("https://www.googleapis.com/auth/", "")).join(", "));
console.log("state :", Buffer.from(p.get("state"), "base64").toString());
' "<paste the URL here>"
```

Expected for the default configuration:

```
scopes: documents, drive, calendar, gmail.modify
state : {"manual":true,"csrf":"..."}
```

If the list contains `chat`, `directory`, `presentations`, `spreadsheets`, or
`tasks`, **stop**. The overrides request 5 or more scopes and Google will block
the consent. Fix the overrides, build a new URL, and never sign in with a URL
that requests more than 4 scopes. `[field-tested 2026-11-05]`

### 2.5 Consent and copy the credential blob

1. Open the URL in a browser. Any device works.
2. Sign in with the chosen account.
3. Read the consent screen; confirm it lists only the expected permissions.
4. Allow them.
5. The browser shows a JSON object with `access_token`, `refresh_token`,
   `scope`, `token_type`, and `expiry_date`.
6. Copy it at once. The access token lives about one hour.

**Do not confuse these two JSON objects:**

| Object | Shape | Use |
|---|---|---|
| Credentials blob | `{"access_token":"ya29...","refresh_token":"1//..."}` | **This is what you need** |
| OAuth client file | `{"installed":{"client_id":"...","client_secret":"GOCSPX-..."}}` | **Not needed. Do not paste this.** |

The upstream Cloud Function holds the client secret. If you paste a client
secret into the chat, rotate it immediately in Google Cloud Console.
`[field-tested 2026-11-05]`

If Google shows **"This app is blocked"**, you requested 5 or more scopes, or
Google changed enforcement. Do not retry the same URL. Rebuild it with fewer
scopes. `[field-tested 2026-11-05]`

### 2.6 Store the blob

The helper in this repository reads the JSON from a **file**, not from
`/dev/tty`. It must be `save-creds.cjs`, not `.mjs`: it uses `require()`, which
does not exist in ES module scope. `[field-tested 2026-11-05]`

```bash
umask 077
cat > /tmp/creds.json     # paste the JSON, then press Ctrl-D
cd "$GWS_ROOT"
GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true \
  node "$GWS_SKILL/scripts/save-creds.cjs" /tmp/creds.json
shred -u /tmp/creds.json 2>/dev/null || rm -f /tmp/creds.json
```

Expected:

```
saved.
  refresh_token: present
  scopes (4):
    calendar
    documents
    drive
    gmail.modify
```

The helper never prints token values. `[field-tested 2026-11-05]`

### 2.7 Restart the bridge — mandatory

The child server reads the stored credentials **one time only**, when it
starts. A token stored after the child started is not used. Tool calls keep the
old state and fail with `Request had invalid authentication credentials`.
`[field-tested 2026-11-05]`

```bash
"$GWS_SKILL/bridge/google-workspace-bridge-start.sh"
```

If the launcher says `already listening`, stop the old bridge first (§8.12),
then start it again.

### 2.8 Where the token lives

| File | Content |
|---|---|
| `$GWS_ROOT/gemini-cli-workspace-token.json` | Encrypted credentials, mode `0600` |
| `$GWS_ROOT/.gemini-cli-workspace-master-key` | Encryption key, mode `0600` |

Both paths are in the upstream `.gitignore`. Confirm before using git in that
directory:

```bash
cd "$GWS_ROOT" && git check-ignore -v gemini-cli-workspace-token.json
```

If git prints nothing, stop and add the paths to `.gitignore` first.
`[upstream 0.0.8 — src/utils/paths.ts]` `[field-tested 2026-11-05]`

Set `GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true` to skip the system keyring.
Containers have no keyring; without the variable the server prints a
`DLOPEN_FAILED` warning and falls back to the file anyway. `[field-tested
2026-11-05]`

### 2.9 Widen the scope set later (within the ceiling)

Order matters. If you restart the bridge with a wider scope set before a token
exists for it, `AuthManager` deletes the stored token on the next call.
`[field-tested 2026-11-05]`

1. Keep the bridge on the current passing configuration.
2. Generate a new URL with the new overrides and `--force`.
3. Sign in. If the browser shows a block, stop; the stored token is unaffected
   on your side.
4. Store the new blob (§2.6).
5. Change the launcher's overrides to the new value.
6. Restart the bridge (§2.7).
7. Call `capabilities_refresh` twice (§1.4).

### 2.10 `invalid_grant` — the grant was revoked

Google revoked the whole grant, usually after a blocked consent or after you
removed the app at `myaccount.google.com`. The refresh token is dead; no script
recovers it. Sign in again at a passing scope set, store the blob, restart the
bridge. `[field-tested 2026-11-05]`

Blocked attempts do not always revoke the grant. Check before you panic:

```bash
cd "$GWS_ROOT"
GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true node -e '
const { OAuthCredentialStorage } = require("./workspace-server/dist/auth-utils.js");
(async () => {
  const c = await OAuthCredentialStorage.loadCredentials();
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: "Bearer " + c.access_token } });
  console.log("token check HTTP:", r.status, r.ok ? "grant ALIVE" : "refresh or re-sign-in");
})();
'
```

### 2.11 Lift the ceiling with your own OAuth client

Host your own OAuth client and Cloud Function by following upstream
`docs/GCP-RECREATION.md`, then add your account as a test user in your own GCP
project. Test users bypass the count block at any scope. Set
`WORKSPACE_CLIENT_ID` and `WORKSPACE_CLOUD_FUNCTION_URL` in the launcher, and
set `WORKSPACE_FEATURE_OVERRIDES` for every group you want. `[web — upstream
GCP-RECREATION.md]` `[untested here]`

Do not create your own OAuth client without also hosting the Cloud Function.
The server always sends Google to
`https://google-workspace-extension.geminicli.com`; your client does not
authorize that redirect URI, and sign-in fails with `redirect_uri_mismatch`.
`[field-tested 2026-11-05]`

---

## 3. Tool surface — 38 tools

`[field-tested 2026-11-05 — live tools/list through the bridge]`

| Group | Count | Tools |
|---|---:|---|
| Gmail | 11 | `gmail.search`, `gmail.get`, `gmail.downloadAttachment`, `gmail.listLabels`, `gmail.modify`, `gmail.batchModify`, `gmail.modifyThread`, `gmail.send`, `gmail.createDraft`, `gmail.sendDraft`, `gmail.createLabel` |
| Drive | 8 | `drive.getComments`, `drive.findFolder`, `drive.search`, `drive.downloadFile`, `drive.createFolder`, `drive.moveFile`, `drive.trashFile`, `drive.renameFile` |
| Docs | 6 | `docs.getSuggestions`, `docs.getText`, `docs.create`, `docs.writeText`, `docs.replaceText`, `docs.formatText` |
| Calendar | 8 | `calendar.list`, `calendar.listEvents`, `calendar.getEvent`, `calendar.findFreeTime`, `calendar.createEvent`, `calendar.updateEvent`, `calendar.respondToEvent`, `calendar.deleteEvent` |
| Time | 3 | `time.getCurrentDate`, `time.getCurrentTime`, `time.getTimeZone` |
| Auth | 2 | `auth.clear`, `auth.refreshToken` |

Without `WORKSPACE_FEATURE_OVERRIDES`, the server registers **57** tools and
asks for 11 scopes. **Do not run it that way with a 4-scope token.** The
server will delete the token on the next call. The default override value
removes 19 tools: Chat (8), People (3), Slides read (5), Sheets read (3).
`[field-tested 2026-11-05]`

Dump the live surface yourself:

```bash
node probe/google-workspace-probe.mjs tools/list
node probe/google-workspace-probe.mjs schema drive.search
```

---

## 4. Calling conventions

- **Tool names differ by layer.** The upstream server uses dotted names
  (`gmail.search`) because the bridge starts it with `--use-dot-names`. PAVE
  sanitizes dots to underscores in the exposed name
  (`mcp_mcp-127-0-0-1_gmail_search`). Use dotted names with the probe; use the
  PAVE-prefixed name from an agent. `[upstream 0.0.8 — src/index.ts:207-208]`
  `[field-tested 2026-11-05]`
- **Read the schema before you guess an argument.** The probe prints the exact
  `inputSchema`. Tool result shapes vary; inspect the raw JSON-RPC result once
  before writing a parser. `[untested — shape varies per tool]`
- **Drive search returns 10 items per page.** Use the response's
  `nextPageToken` as the next call's `pageToken`. `[field-tested 2026-11-05]`
- **Drive queries use the Drive query language**, for example:

  ```
  trashed = false and 'root' in parents
  mimeType = 'application/vnd.google-apps.document'
  ```

  Find a document first, then read it:

  ```
  drive.search:  mimeType = 'application/vnd.google-apps.document'
  docs.getText:  <the document id from the result>
  ```

  `[field-tested 2026-11-05]`
- **There is no general file-upload tool in this set.** Drive tools search,
  download, create folders, move, rename, and trash. Use `docs.create` to
  create a Doc. `[upstream 0.0.8 — src/features/feature-config.ts]`
- **Gmail search takes a Gmail query string.** `gmail.get` needs the message id
  from a search result. `gmail.downloadAttachment` needs the message id plus the
  attachment id returned by `gmail.get`. `gmail.send` requires recipients,
  subject, and body. The live schema is authoritative. `[upstream 0.0.8]`
- **Calendar** distinguishes calendars (`calendar.list`) from events
  (`calendar.listEvents`, `calendar.getEvent`). Use the calendar id from
  `calendar.list`; do not assume `primary`. `[upstream 0.0.8]`
- **Time tools use the server's timezone.** Call `time.getTimeZone` before
  converting a date, or pass an explicit timezone where the schema allows it.
  `[upstream 0.0.8]`
- **No Sheets, Slides, Tasks, Chat, or People tools are reachable** under the
  default 4-scope install. Do not promise them. `[field-tested 2026-11-05]`

---

## 5. Diagnostic fallback: drive the server directly

The bridge can swallow the real error text from the upstream server. When a
bridged call fails with a bare `isError`, use the committed probe. It is in this
repository, so unlike a probe in `~/.pave/cache` it survives cache wipes.
`[playbook]`

Through the bridge (default, no token needed on loopback):

```bash
node probe/google-workspace-probe.mjs health
node probe/google-workspace-probe.mjs tools/list
node probe/google-workspace-probe.mjs schema gmail.search
node probe/google-workspace-probe.mjs call gmail.listLabels '{}'
node probe/google-workspace-probe.mjs call drive.search @args.json
```

Directly against the stdio server, bypassing the bridge:

```bash
GWS_ROOT=/home/pave/workspace/google-workspace \
WORKSPACE_FEATURE_OVERRIDES="chat.read:off,chat.write:off,people.read:off,slides.read:off,sheets.read:off" \
node probe/google-workspace-probe.mjs --stdio tools/list
```

Expected on a healthy build: the bridge reports `google-workspace 0.0.8`; the
stdio child reports `google-workspace-server 0.0.8`. The tool count is 57
without the overrides or 38 with them. `[field-tested 2026-11-05]`

The probe accepts **no token on the command line** and never prints
credentials. It reads none: the bridge is loopback-only, and the stdio child
reads its own encrypted store. `[verified by inspection]`

---

## 6. Config reference

| Key | Where | Purpose | Status |
|---|---|---|---|
| `GWS_WORKDIR` | shell / launcher | Working directory (default `/home/pave/workspace`) | `[field-tested 2026-11-05]` |
| `GWS_ROOT` | shell / launcher / probe | Upstream clone (default `$GWS_WORKDIR/google-workspace`) | `[field-tested 2026-11-05]` |
| `GWS_SKILL` | shell | This skill's install directory, for the helper paths | `[verified by layout]` |
| `WORKSPACE_FEATURE_OVERRIDES` | launcher / login | Feature and scope selection; must match the token | `[upstream 0.0.8 — src/features/feature-resolver.ts]` |
| `GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE` | launcher / helper | `true` forces encrypted file storage | `[upstream 0.0.8 — src/auth/token-storage/hybrid-token-storage.ts]` |
| `WORKSPACE_CLIENT_ID` | launcher | Own OAuth client id (optional) | `[upstream 0.0.8 — src/utils/config.ts]` |
| `WORKSPACE_CLOUD_FUNCTION_URL` | launcher | Own Cloud Function (optional) | `[upstream 0.0.8 — src/utils/config.ts]` |
| `MCP_URL` | probe | Bridge endpoint (default `http://127.0.0.1:4318/mcp`) | `[verified by inspection]` |
| `PAVE_CAPABILITIES_EXPERIMENTAL` | PAVE env | Required for `capabilities_*` | `[playbook]` |
| `mcp-127-0-0-1` | `~/.pave/permissions.yaml` → `mcp.allowed` | R10 first-use approval | `[field-tested 2026-11-05]` |
| Token file | `$GWS_ROOT/gemini-cli-workspace-token.json` | Encrypted credentials, `0600` | `[upstream 0.0.8]` |
| Master key | `$GWS_ROOT/.gemini-cli-workspace-master-key` | Encryption key, `0600` | `[upstream 0.0.8]` |
| Bridge log | `$GWS_WORKDIR/bridge.log` | Bridge and child stderr | `[field-tested 2026-11-05]` |

---

## 7. Open questions

1. Does the bridge pick up tool-list changes without a restart? `[untested]`
2. Does unattended token refresh work across the one-hour expiry boundary
   without a human touching the bridge? `[untested — the field run finished
   inside one token lifetime]`
3. Do Sheets, Slides, Tasks, Chat, and People work end to end with a
   self-hosted OAuth client and test-user bypass? `[untested here]`
4. Does the 4-scope ceiling still hold? Google can change enforcement; the
   ladder in §2.2 is dated 2026-11-05. `[field-tested 2026-11-05]`
5. Does the bridge stringify structured tool results, as the Dropbox bridge
   does? `[untested for this bridge]`
6. Does the doubled-result bridge defect from the Wrike doctrine reproduce
   here? `[untested]`
7. Does the `capabilities_refresh`-twice rule still hold after a restart?
   `[field-tested 2026-11-05]`
8. Does the launcher work on a Windows host? The bridge is plain Node, but the
   launcher is POSIX `sh`. `[untested]`

---

## 8. Troubleshooting

### 8.1 Build fails with `MODULE_NOT_FOUND: esbuild`

DevDependencies are missing, because `NODE_ENV=production` or because the
`prepare` script ran before them. Fix:

```bash
cd "$GWS_ROOT"
NODE_ENV=development npm install --include=dev --ignore-scripts
NODE_ENV=development npm run build
```

### 8.2 `ENXIO: no such device or address, open '/dev/tty'`

Expected in a container. Do not fix it. Use §2.3 through §2.6.

### 8.3 The tool count is 57, not 38

The bridge started without `WORKSPACE_FEATURE_OVERRIDES`. **Act fast:** while
the count is 57 the server needs 11 scopes, your token has 4, and the next call
deletes the token. Stop the bridge (§8.12), start it with the launcher, and
confirm 38.

### 8.4 `No credentials found` after it worked before

`AuthManager` deleted the token, usually from a scope mismatch. The refresh
token is still valid unless Google revoked the grant (§8.9). Recover without a
new sign-in:

```bash
cd "$GWS_ROOT"
GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true node -e '
const { OAuthCredentialStorage } = require("./workspace-server/dist/auth-utils.js");
(async () => {
  const res = await fetch("https://google-workspace-extension.geminicli.com/refreshToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: process.argv[1] }),
  });
  if (!res.ok) { console.log("HTTP", res.status, (await res.text()).slice(0, 200)); process.exit(1); }
  const t = await res.json();
  await OAuthCredentialStorage.saveCredentials({
    access_token: t.access_token,
    refresh_token: t.refresh_token || process.argv[1],
    scope: t.scope || "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar",
    token_type: t.token_type || "Bearer",
    expiry_date: t.expiry_date || (Date.now() + (t.expires_in || 3600) * 1000),
  });
  console.log("recovered");
})();
' "<your refresh token>"
```

Then **restart the bridge**. You cannot refresh this token directly against
Google: the shared client has no client secret on your side, and Google answers
`client_secret is missing`. `[field-tested 2026-11-05]`

### 8.5 `Session not found`

Use `capabilities_refresh` and call it twice. The first call fails; the second
succeeds. `[field-tested 2026-11-05]`

### 8.6 `requires approval on first use (R10)`

See §1.3. Add `mcp-127-0-0-1` to `mcp.allowed` in
`~/.pave/permissions.yaml`. The `permission` tool cannot do it.

### 8.7 `ReferenceError: require is not defined in ES module scope`

Your helper file ends in `.mjs`. Use `save-creds.cjs`. `[field-tested
2026-11-05]`

### 8.8 `redirect_uri_mismatch`

You used your own OAuth client without hosting the matching Cloud Function. Use
the shared client URL from §2.3, or complete `docs/GCP-RECREATION.md`.
`[field-tested 2026-11-05]`

### 8.9 `invalid_grant` — "Token has been expired or revoked"

Google revoked the grant. No script recovers it. Sign in again at a passing
scope set, store the blob, restart the bridge. Check first with the token probe
in §2.10. `[field-tested 2026-11-05]`

### 8.10 Real calls fail with `invalid authentication credentials`, but `auth-utils status` says `Valid`

The child holds credentials cached from before the token was stored. Restart
the bridge. `[field-tested 2026-11-05]`

### 8.11 `This app is blocked` in the browser

You requested 5 or more scopes. Do not retry the same URL. Rebuild it with a
passing override value. Check whether the old grant survived (§2.10).
`[field-tested 2026-11-05]`

### 8.12 `pkill` does not stop the bridge

Some containers restrict `pkill` and `ps`. Use a `/proc` scan:

```bash
for d in /proc/[0-9]*; do pid=${d#/proc/}; [ "$pid" = "$$" ] && continue
  if [ -r "$d/cmdline" ]; then c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
    case "$c" in *"node google-workspace-bridge.mjs"*) kill "$pid" 2>/dev/null && echo "killed bridge $pid";; esac
  fi
done
sleep 2
curl -s -m 2 http://127.0.0.1:4318/health >/dev/null 2>&1 && echo "still up" || echo "port free"
```

### 8.13 The login command prints `Already authenticated` and no URL

Valid credentials are stored. Add `--force` (§2.3). `[field-tested 2026-11-05]`

---

## 9. Setup runbook — zero to working

Follow top to bottom. Do not skip; each step depends on the previous one.

### 9.0 Preflight

```bash
export GWS_WORKDIR=/home/pave/workspace
export GWS_ROOT="$GWS_WORKDIR/google-workspace"
export GWS_SKILL="$HOME/.pave/skills/google-workspace-mcp"
mkdir -p "$GWS_WORKDIR"

node --version      # >= 20
git --version
curl --version
env | grep -E '^NODE_ENV=' || true
```

If `NODE_ENV=production`, override it in every npm command below.

### 9.1 Get the source

Use the upstream repository, or the public fork made for this skill:

```bash
cd "$GWS_WORKDIR"
git clone --depth 1 https://github.com/gemini-cli-extensions/workspace.git google-workspace
cd google-workspace
```

Expected: `gemini-extension.json` and `workspace-server/` exist.

### 9.2 Install dependencies

```bash
cd "$GWS_ROOT"
NODE_ENV=development npm install --include=dev --ignore-scripts
ls -d node_modules/esbuild node_modules/typescript node_modules/@modelcontextprotocol/sdk
```

All three paths must exist before you continue.

### 9.3 Build the server and the auth utilities

`npm run build` alone does **not** build `auth-utils.js`. The login step and the
credential helper both need it.

```bash
cd "$GWS_ROOT"
NODE_ENV=development npm run build
cd workspace-server
NODE_ENV=development node esbuild.auth-utils.js
ls -la dist/
```

Expected, in order: `Build completed successfully!`, then
`Auth Utils build completed successfully!`, then `index.js` (about 13 MB),
`auth-utils.js` (about 10 KB), and `headless-login.js`.
`[field-tested 2026-11-05]`

### 9.4 Probe the build over stdio

```bash
GWS_ROOT="$GWS_ROOT" \
node "$GWS_SKILL/probe/google-workspace-probe.mjs" --stdio tools/list
```

Expected: `server: google-workspace-server 0.0.8` and `(38 tools)`. The probe
applies the 4-scope default, so it cannot silently widen the request. The
upstream server's full default surface is 57 tools. To see 57 deliberately:

```bash
WORKSPACE_FEATURE_OVERRIDES= GWS_ROOT="$GWS_ROOT" \
node "$GWS_SKILL/probe/google-workspace-probe.mjs" --stdio tools/list
```

`[field-tested 2026-11-05]`

### 9.5 Install this skill's helpers

```bash
pave install johnmak101-ops/openpave-google-workspace-mcp
cd "$GWS_SKILL" && git pull --ff-only
```

`pave install` can land a stale clone; pull before using the helpers. Confirm
the expected files exist:

```bash
ls bridge/google-workspace-bridge.mjs scripts/save-creds.cjs probe/google-workspace-probe.mjs
```

### 9.6 Start the bridge

```bash
"$GWS_SKILL/bridge/google-workspace-bridge-start.sh"
```

Expected:

```
{"ok":true,"sessions":0,"upstream":false}
ok: http://127.0.0.1:4318/mcp
```

`upstream:false` is correct before the first tool call; the bridge starts the
child lazily.

### 9.7 Register and open the gate

```bash
# In PAVE:
capabilities_add http://127.0.0.1:4318/mcp
capabilities_status mcp-127-0-0-1
```

Accept the card, then add `mcp-127-0-0-1` to `mcp.allowed` (§1.3).

### 9.8 Sign in

Run §2.3. Decode and check the URL (§2.4). Open it, consent, copy the blob
(§2.5).

### 9.9 Store the blob and restart

Run §2.6, then §2.7. The restart is mandatory.

### 9.10 Verify

```bash
cd "$GWS_ROOT"
GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true node scripts/auth-utils.js status
curl -s http://127.0.0.1:4318/health
node "$GWS_SKILL/probe/google-workspace-probe.mjs" tools/list
```

Expected: `Access Token: Present`, `Refresh Token: Present`, `Status: Valid`;
`"ok":true`; 38 tools.

Then make real calls in PAVE:

```
gmail.listLabels
calendar.list
drive.search  {"query":"trashed = false and 'root' in parents"}
drive.search  {"query":"mimeType = 'application/vnd.google-apps.document'"}
docs.getText  <id from the previous result>
```

Every call must return your real data. The first call triggers R10; open the
gate (§1.3) and retry. `[field-tested 2026-11-05]`

### 9.11 Known-good state — what "done" looks like

| Artifact | Expected value |
|---|---|
| `capabilities_status mcp-127-0-0-1` | `installed` |
| Bridged tool count | 38 |
| `bridge.log` | `LISTENING`, then `UPSTREAM_CONNECTED` after the first call |
| `auth-utils status` | access present, refresh present, valid |
| `permissions.yaml` | `mcp.allowed` contains `mcp-127-0-0-1` |
| `tools/list` | 38 dotted names |
| Real calls | Gmail, Calendar, Drive, Docs return live data |

Compare against this table, not against "it seemed to work". Every row was
observed on a working install. `[field-tested 2026-11-05]`

---

## 10. Removal

Do these in order.

1. Revoke the token at Google:
   [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
   Find **Gemini CLI Workspace Extension**, select **Remove**. This is the
   important step; it stops access even if a token file survives.
2. Delete the credential files:

   ```bash
   shred -u "$GWS_ROOT/gemini-cli-workspace-token.json" 2>/dev/null
   shred -u "$GWS_ROOT/.gemini-cli-workspace-master-key" 2>/dev/null
   ```

3. Stop the bridge:

   ```bash
   pkill -f google-workspace-bridge.mjs 2>/dev/null || true
   ```

   If `pkill` fails, use §8.12.
4. In PAVE: `capabilities_uninstall mcp:127.0.0.1`.
5. Remove the `mcp-127-0-0-1` entry from `~/.pave/permissions.yaml`.
6. Delete the working directory:

   ```bash
   rm -rf "$GWS_ROOT" "$GWS_WORKDIR"/bridge.log
   ```

7. If you pasted an OAuth client secret into the chat at any point, rotate it
   in Google Cloud Console.

---

## Appendix A — The tested scope ladder

| # | Scopes requested | Verdict |
|---|---|---|
| 1 | `drive`, `gmail.modify` | **granted** (24 tools) |
| 2 | + `documents` | **granted** (30 tools) |
| 3 | + `calendar` | **granted** (38 tools) — **default of this skill** |
| 4 | + `spreadsheets` (5 total) | blocked |
| 5 | + `presentations` (5 total) | blocked |
| 6 | + `tasks.readonly` (5 total) | blocked |
| 7 | 6 scopes, one shot | blocked |
| 8 | 12 scopes, one shot | blocked |

`[field-tested 2026-11-05]`

## Appendix B — Feature groups, scopes, and defaults

Set `WORKSPACE_FEATURE_OVERRIDES` to `group:off` to remove a group, or
`group:on` to add a group that is off by default. The key is `service.group`.
Tool-level overrides are subtractive only; `tool:on` cannot enable a tool whose
group is off. `[upstream 0.0.8 — src/features/feature-config.ts, docs/feature-configuration.md]`

| Group key | OAuth scopes | Default |
|---|---|---|
| `docs.read` | `documents` | on |
| `docs.write` | `documents` | on |
| `drive.read` | `drive.readonly` | on |
| `drive.write` | `drive` | on |
| `calendar.read` | `calendar.readonly` | on |
| `calendar.write` | `calendar` | on |
| `chat.read` | `chat.spaces.readonly`, `chat.messages.readonly`, `chat.memberships.readonly` | on |
| `chat.write` | `chat.spaces`, `chat.messages`, `chat.memberships` | on |
| `gmail.read` | `gmail.readonly` | on |
| `gmail.write` | `gmail.modify` | on |
| `people.read` | `userinfo.profile`, `directory.readonly` | on |
| `slides.read` | `presentations.readonly` | on |
| `slides.write` | `presentations` | off |
| `sheets.read` | `spreadsheets.readonly` | on |
| `sheets.write` | `spreadsheets` | off |
| `time.read` | none | on |
| `tasks.read` | `tasks.readonly` | off |
| `tasks.write` | `tasks` | off |

Redundant scopes are removed. Enabling both `gmail.read` and `gmail.write`
requests only `gmail.modify`; enabling both `docs.read` and `docs.write`
requests only `documents`. The default override in §2.3 leaves docs, drive,
calendar, and gmail on, and turns off `chat.read`, `chat.write`, `people.read`,
`slides.read`, and `sheets.read`.

## Appendix C — Helper inventory

| Path | Purpose |
|---|---|
| `bridge/google-workspace-bridge.mjs` | Republish the stdio server as Streamable HTTP on `127.0.0.1:4318` |
| `bridge/google-workspace-bridge-start.sh` | Idempotent launcher: sets overrides, starts the bridge, prints health |
| `scripts/save-creds.cjs` | Write the credentials blob into the encrypted token store |
| `probe/google-workspace-probe.mjs` | Token-safe JSON-RPC probe; bridge mode and `--stdio` mode |

The bridge reads `GWS_ROOT` and resolves the MCP SDK from
`$GWS_ROOT/node_modules/@modelcontextprotocol/sdk/dist/cjs`. Export `GWS_ROOT`
before starting it if you bypass the launcher.
