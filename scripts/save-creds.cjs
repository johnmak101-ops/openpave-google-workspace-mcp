#!/usr/bin/env node
/*
 * Save Google OAuth credentials JSON into the Google Workspace extension's
 * encrypted token store. Reads the JSON from a FILE path, not /dev/tty,
 * because a container has no controlling terminal.
 *
 * Usage:
 *   GWS_ROOT=/path/to/google-workspace \
 *     node save-creds.cjs /path/to/credentials.json
 *
 * The file is the blob the upstream manual-mode login page shows after
 * sign-in:
 *   { access_token, refresh_token, expiry_date, scope, token_type }
 *
 * It is NOT an OAuth client file:
 *   { "installed": { "client_id": ..., "client_secret": ... } }
 */
'use strict';

const fs = require('node:fs');

const ROOT =
  process.env.GWS_ROOT || '/home/pave/workspace/google-workspace';

const { OAuthCredentialStorage } = require(
  `${ROOT}/workspace-server/dist/auth-utils.js`,
);

async function main() {
  const p = process.argv[2];
  if (!p) {
    console.error('usage: node save-creds.cjs <credentials.json>');
    process.exit(2);
  }

  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    console.error('cannot read', p, '-', e.code);
    process.exit(2);
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    console.error('not valid JSON');
    process.exit(2);
  }

  if (j.installed || j.web) {
    console.error('this looks like an OAuth client file, not a credentials blob.');
    console.error('Do not paste or store it. The shared client needs no client secret.');
    process.exit(2);
  }
  if (!j.access_token) {
    console.error('JSON has no access_token - is this the credentials blob,');
    console.error('not an OAuth client secret file?');
    process.exit(2);
  }

  await OAuthCredentialStorage.saveCredentials({
    access_token: j.access_token,
    refresh_token: j.refresh_token || null,
    scope: j.scope || undefined,
    token_type: j.token_type || 'Bearer',
    expiry_date: j.expiry_date
      ? parseInt(j.expiry_date, 10)
      : Date.now() + 3600 * 1000,
  });

  // Never echo the tokens themselves.
  console.log('saved.');
  console.log('  refresh_token:', j.refresh_token ? 'present' : 'MISSING');
  const scopes = (j.scope || '').split(/\s+/).filter(Boolean);
  console.log('  scopes (' + scopes.length + '):');
  scopes.forEach((s) =>
    console.log('    ' + s.replace('https://www.googleapis.com/auth/', '')),
  );
}

main().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
