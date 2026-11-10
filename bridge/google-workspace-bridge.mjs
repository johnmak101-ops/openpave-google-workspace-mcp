#!/usr/bin/env node
/*
 * google-workspace stdio -> loopback HTTP MCP bridge.
 *
 * PAVE registers MCP servers by URL. The Google Workspace server from
 * gemini-cli-extensions/workspace speaks MCP over stdio only. This bridge runs
 * that server as a child process and republishes it over Streamable HTTP on
 * 127.0.0.1.
 *
 * Usage:
 *   GWS_ROOT=/path/to/google-workspace node google-workspace-bridge.mjs [port]
 *
 * Environment:
 *   GWS_ROOT  clone of gemini-cli-extensions/workspace (required)
 *   PORT      optional, overridden by argv[2]
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.GWS_ROOT || '/home/pave/workspace/google-workspace';
const SDK = `${ROOT}/node_modules/@modelcontextprotocol/sdk/dist/cjs`;
const SERVER_PATH = `${ROOT}/workspace-server/dist/index.js`;
const PORT = Number(process.argv[2] || process.env.PORT || 4318);
const HOST = '127.0.0.1';

const log = (...a) =>
  console.log(
    new Date().toISOString(),
    ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))),
  );

function fail(message, hint) {
  log('FATAL', message);
  if (hint) log('HINT', hint);
  process.exit(1);
}

if (!fs.existsSync(SERVER_PATH)) {
  fail(
    `server not built: ${SERVER_PATH}`,
    'Run: cd "$GWS_ROOT" && NODE_ENV=development npm install --include=dev --ignore-scripts && npm run build && (cd workspace-server && NODE_ENV=development node esbuild.auth-utils.js)',
  );
}
if (!fs.existsSync(`${SDK}/client/index.js`)) {
  fail(
    `MCP SDK not found at ${SDK}`,
    'Install dependencies with NODE_ENV=development npm install --include=dev --ignore-scripts',
  );
}

// file:// URLs keep the imports valid on both POSIX and Windows hosts.
const sdkImport = (rel) => import(pathToFileURL(`${SDK}/${rel}`).href);

const { Client } = await sdkImport('client/index.js');
const { StdioClientTransport } = await sdkImport('client/stdio.js');
const { Server } = await sdkImport('server/index.js');
const { StreamableHTTPServerTransport } = await sdkImport('server/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  CompleteRequestSchema,
  PingRequestSchema,
} = await sdkImport('types.js');

// ---------------------------------------------------------------- upstream
let upstream = null;
let upstreamPromise = null;

async function getUpstream() {
  if (upstream) return upstream;
  if (!upstreamPromise) {
    upstreamPromise = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_PATH, '--debug', '--use-dot-names'],
        env: {
          ...process.env,
          // No keyring in a container: keep OAuth tokens in the encrypted
          // file store instead of failing on keytar.
          GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE: 'true',
        },
        stderr: 'inherit',
      });
      const client = new Client({ name: 'gws-bridge', version: '1.0.0' });
      await client.connect(transport);
      transport.onclose = () => {
        log('UPSTREAM_CLOSED');
        upstream = null;
        upstreamPromise = null;
      };
      upstream = client;
      log('UPSTREAM_CONNECTED');
      return client;
    })().catch((e) => {
      upstreamPromise = null;
      throw e;
    });
  }
  return upstreamPromise;
}

const methodNotFound = (method) => ({
  code: -32601,
  message: `Method not found: ${method}`,
});

// Build a fresh downstream Server per session, proxying everything upstream.
function makeDownstream() {
  const server = new Server(
    { name: 'google-workspace', version: '0.0.8' },
    { capabilities: { tools: {}, resources: {}, prompts: {}, completions: {} } },
  );

  server.setRequestHandler(PingRequestSchema, async () => ({}));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const c = await getUpstream();
    return c.listTools();
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const c = await getUpstream();
    log('CALL', req.params.name);
    return c.callTool({ name: req.params.name, arguments: req.params.arguments });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const c = await getUpstream();
    return c.listResources();
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const c = await getUpstream();
    return c.readResource({ uri: req.params.uri });
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const c = await getUpstream();
    return c.listPrompts();
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const c = await getUpstream();
    return c.getPrompt({ name: req.params.name, arguments: req.params.arguments });
  });

  server.setRequestHandler(CompleteRequestSchema, async (req) => {
    const c = await getUpstream();
    return c.complete(req.params);
  });

  server.fallbackRequestHandler = (req) => {
    throw methodNotFound(req.method);
  };

  return server;
}

// ---------------------------------------------------------------- HTTP
const sessions = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!raw.length) return resolve(undefined);
      try {
        resolve(JSON.parse(raw.toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ ok: true, sessions: sessions.size, upstream: !!upstream }),
    );
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
    return;
  }

  const sessionId = req.headers['mcp-session-id'];

  try {
    if (req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' },
            id: null,
          }),
        );
        return;
      }

      let transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport) {
        // A POST that is not an initialize against an unknown session is invalid.
        const isOpen = Array.isArray(body)
          ? body.some((m) => m.method === 'initialize')
          : body?.method === 'initialize';
        if (sessionId || !isOpen) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            }),
          );
          return;
        }
        const server = makeDownstream();
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, t);
            log('SESSION_OPEN', sid, 'total', sessions.size);
          },
        });
        t.onclose = () => {
          if (t.sessionId) {
            sessions.delete(t.sessionId);
            log('SESSION_CLOSE', t.sessionId, 'total', sessions.size);
          }
        };
        await server.connect(t);
        await t.handleRequest(req, res, body);
        return;
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const t = sessionId ? sessions.get(sessionId) : undefined;
      if (!t) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Missing or invalid mcp-session-id\n');
        return;
      }
      await t.handleRequest(req, res);
      return;
    }

    res.writeHead(405, {
      allow: 'GET, POST, DELETE',
      'content-type': 'text/plain',
    });
    res.end('method not allowed\n');
  } catch (e) {
    log('ERROR', e?.message || String(e));
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
    }
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: String(e?.message || e) },
        id: null,
      }),
    );
  }
});

httpServer.listen(PORT, HOST, () =>
  log('LISTENING', `http://${HOST}:${PORT}/mcp`),
);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('SHUTDOWN', sig);
    httpServer.close();
    if (upstream) upstream.close();
    setTimeout(() => process.exit(0), 200);
  });
}
