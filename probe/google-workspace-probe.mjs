#!/usr/bin/env node
// google-workspace-probe.mjs — diagnostic JSON-RPC probe for the Google
// Workspace MCP server. Speaks to the loopback bridge by default, or spawns
// the stdio server with --stdio.
//
// The probe is committed to the repository so it survives ~/.pave/cache
// wipes. It accepts no token on the command line and prints none.
//
// Usage:
//   node probe/google-workspace-probe.mjs health
//   node probe/google-workspace-probe.mjs tools/list
//   node probe/google-workspace-probe.mjs schema <tool>
//   node probe/google-workspace-probe.mjs call <tool> '<json-args>'
//   node probe/google-workspace-probe.mjs call <tool> @args.json
//   node probe/google-workspace-probe.mjs --stdio tools/list
//
// Env:
//   MCP_URL   bridge endpoint (default http://127.0.0.1:4318/mcp)
//   GWS_ROOT  upstream clone  (default /home/pave/workspace/google-workspace)
//   WORKSPACE_FEATURE_OVERRIDES
//             overrides for the --stdio child. When unset, the 4-scope default
//             from SKILL.md is applied so a probe cannot silently widen the
//             scope set and make AuthManager delete the token.
//             Set it empty to probe the full 57-tool surface.

'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:4318/mcp';
const GWS_ROOT =
  process.env.GWS_ROOT || '/home/pave/workspace/google-workspace';
const DEFAULT_OVERRIDES =
  'chat.read:off,chat.write:off,people.read:off,slides.read:off,sheets.read:off';

const argv = process.argv.slice(2);
const stdioMode = argv.includes('--stdio');
const args = argv.filter((a) => a !== '--stdio');
const cmd = args[0];
const arg = args[1];

function die(msg) {
  console.error('google-workspace-probe: ' + msg);
  process.exit(1);
}

// ---------------------------------------------------------------- bridge HTTP
let sessionId = null;
let nextId = 1;

async function httpRpc(method, params, notification) {
  const body = { jsonrpc: '2.0', method };
  if (!notification) body.id = nextId++;
  if (params !== undefined) body.params = params;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();

  if (res.status !== 200 && res.status !== 202) {
    const hint =
      res.status === 404
        ? ' — session lost; restart the bridge (SKILL.md 2.7)'
        : res.status === 400
          ? ' — malformed request or missing session id'
          : '';
    die(
      `HTTP ${res.status} from ${MCP_URL} (${ct})${hint}` +
        (raw && raw.length < 400 ? '\n' + raw : ''),
    );
  }
  if (!raw.trim()) return null;

  if (ct.includes('text/event-stream')) {
    const lines = raw.split('\n').filter((l) => l.startsWith('data:'));
    if (!lines.length) die('SSE response with no data: lines');
    return JSON.parse(lines[lines.length - 1].slice(5).trim());
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`non-JSON response (${ct}, ${raw.length} bytes) — ${e.message}`);
  }
}

async function httpHealth() {
  const origin = new URL(MCP_URL).origin;
  const res = await fetch(`${origin}/health`);
  const raw = await res.text();
  if (!res.ok) die(`HTTP ${res.status} from ${origin}/health\n${raw}`);
  console.log(raw);
}

// ---------------------------------------------------------------- stdio child
function startStdio() {
  const serverPath = `${GWS_ROOT}/workspace-server/dist/index.js`;
  if (!fs.existsSync(serverPath)) {
    die(
      `server not built: ${serverPath}\n` +
        'run: cd "$GWS_ROOT" && NODE_ENV=development npm install --include=dev --ignore-scripts && npm run build',
    );
  }
  const overrides =
    process.env.WORKSPACE_FEATURE_OVERRIDES === undefined
      ? DEFAULT_OVERRIDES
      : process.env.WORKSPACE_FEATURE_OVERRIDES;

  const child = spawn(
    process.execPath,
    [serverPath, '--debug', '--use-dot-names'],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE: 'true',
        WORKSPACE_FEATURE_OVERRIDES: overrides,
      },
    },
  );

  let buf = '';
  const pending = new Map();
  let id = 1;

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    }
  });

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const n = id++;
      const t = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`timeout in ${method}`));
      }, 60000);
      pending.set(n, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n',
      );
    });

  return { child, rpc, overrides };
}

// ---------------------------------------------------------------- commands
async function main() {
  if (!cmd) {
    die('usage: [--stdio] health | tools/list | schema <tool> | call <tool> <json|@file>');
  }

  if (cmd === 'health') {
    if (stdioMode) die('health is a bridge command; drop --stdio');
    await httpHealth();
    return;
  }

  let call;
  let overrides = null;
  let child = null;

  if (stdioMode) {
    const s = startStdio();
    child = s.child;
    overrides = s.overrides;
    const init = await s.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'google-workspace-probe', version: '0.1.0' },
    });
    if (init.error) die('initialize failed: ' + JSON.stringify(init.error));
    const si = init.result?.serverInfo || {};
    console.error(`server: ${si.name || '?'} ${si.version || '?'}`);
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
        '\n',
    );
    call = s.rpc;
  } else {
    const init = await httpRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'google-workspace-probe', version: '0.1.0' },
    });
    if (init?.error) die('initialize failed: ' + JSON.stringify(init.error));
    const si = init?.result?.serverInfo || {};
    console.error(`server: ${si.name || '?'} ${si.version || '?'}`);
    await httpRpc('notifications/initialized', undefined, true);
    call = httpRpc;
  }

  if (overrides !== null) {
    console.error(`overrides: ${overrides || '(none — full surface)'}`);
  }

  if (cmd === 'tools/list') {
    const out = await call('tools/list', {});
    if (out?.error) die('tools/list failed: ' + JSON.stringify(out.error));
    const tools = out?.result?.tools || [];
    for (const t of tools) {
      console.log(
        '- ' + t.name + ': ' +
          String(t.description || '').replace(/\s+/g, ' ').slice(0, 140),
      );
    }
    console.log(`(${tools.length} tools)`);
  } else if (cmd === 'schema') {
    if (!arg) die('usage: schema <tool>');
    const out = await call('tools/list', {});
    if (out?.error) die('tools/list failed: ' + JSON.stringify(out.error));
    const t = (out?.result?.tools || []).find((x) => x.name === arg);
    if (!t) die('no such tool: ' + arg);
    console.log(JSON.stringify(t, null, 2));
  } else if (cmd === 'call') {
    const tool = arg;
    let argsRaw = args[2];
    if (!tool || argsRaw === undefined) {
      die('usage: call <tool> <json-args|@file>');
    }
    if (argsRaw.startsWith('@')) {
      argsRaw = fs.readFileSync(argsRaw.slice(1), 'utf8');
    }
    let callArgs;
    try {
      callArgs = argsRaw.trim() === '' ? {} : JSON.parse(argsRaw);
    } catch (e) {
      die('args are not valid JSON — ' + e.message);
    }
    const out = await call('tools/call', {
      name: tool,
      arguments: callArgs,
    });
    console.log(JSON.stringify(out, null, 2));
    if (out?.error || out?.result?.isError) {
      if (child) child.kill();
      process.exit(2);
    }
  } else {
    die(`unknown command: ${cmd}`);
  }

  if (child) child.kill();
}

main().catch((e) => die(e.message));
