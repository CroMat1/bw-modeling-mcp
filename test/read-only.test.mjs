// Modalita' sola lettura (BW_READ_ONLY). Nessun contatto con SAP: il server parte senza
// BW_URL/credenziali e con BW_PLATFORM=bw4, che salta la rilevazione della piattaforma.
// Nota: la cartella `tests/` e' nel .gitignore del progetto upstream, per questo si usa `test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { applyServerMode, isReadOnlyTool, readOnlyMode, toolAnnotations } from '../dist/scopes.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, 'dist', 'stdio.js');

/** Ambiente pulito: nessuna variabile BW_* / proxy ereditata dalla shell. */
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^BW_/i.test(k) || /^(HTTPS?|NO)_PROXY$/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, BW_PLATFORM: 'bw4', ...extra };
}

/** initialize + tools/list via stdio; restituisce { init, tools }. */
function probe(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: cleanEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let init;
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 20000);
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          init = msg.result;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ init, tools: msg.result.tools });
        }
      }
    });
    child.on('error', reject);
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'read-only-test', version: '0' } },
    });
  });
}

test('readOnlyMode: attivo per default, spento solo da "0" o "false"', () => {
  assert.equal(readOnlyMode({}), true);
  assert.equal(readOnlyMode({ BW_READ_ONLY: '' }), true);
  assert.equal(readOnlyMode({ BW_READ_ONLY: '1' }), true);
  assert.equal(readOnlyMode({ BW_READ_ONLY: 'no' }), true);
  assert.equal(readOnlyMode({ BW_READ_ONLY: '0' }), false);
  assert.equal(readOnlyMode({ BW_READ_ONLY: 'false' }), false);
  assert.equal(readOnlyMode({ BW_READ_ONLY: ' FALSE ' }), false);
});

test('un tool sconosciuto e\' una scrittura', () => {
  assert.equal(isReadOnlyTool('bw_nuovo_tool_mai_visto'), false);
  assert.deepEqual(applyServerMode([{ name: 'bw_nuovo_tool_mai_visto' }], true), []);
});

test('annotazioni: letture readOnly, cancellazioni destructive', () => {
  assert.deepEqual(toolAnnotations('bw_get_adso'), { readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  assert.equal(toolAnnotations('bw_delete').destructiveHint, true);
  assert.equal(toolAnnotations('bw_run_dtp').destructiveHint, true);
  assert.equal(toolAnnotations('bw_create_adso').readOnlyHint, false);
  assert.equal(toolAnnotations('bw_create_adso').destructiveHint, false);
});

const WRITE_PATTERN = /^bw_(create|update|delete|activate|run|start|push|set|change|move|unlock|save|remove|add|append|swap)_|^bw_(delete|activate|unlock)$/;

test('stdio, default (read-only): tools/list senza scritture', async () => {
  const { init, tools } = await probe({});
  const names = tools.map((t) => t.name);
  assert.ok(names.length > 0);
  for (const t of tools) {
    assert.ok(isReadOnlyTool(t.name), `scrittura esposta in read-only: ${t.name}`);
    assert.ok(!WRITE_PATTERN.test(t.name), `nome da scrittura esposto in read-only: ${t.name}`);
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} senza readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false);
  }
  for (const w of ['bw_delete', 'bw_run_dtp', 'bw_start_process_chain', 'bw_push_data', 'bw_create_transport_task', 'bw_activate']) {
    assert.ok(!names.includes(w), `${w} non deve esserci`);
  }
  assert.match(init.instructions, /READ-ONLY MODE/);
});

test('stdio, BW_READ_ONLY=0: tools/list con le scritture e annotate', async () => {
  const ro = await probe({ BW_READ_ONLY: '1' });
  const full = await probe({ BW_READ_ONLY: '0' });
  const names = full.tools.map((t) => t.name);
  assert.ok(full.tools.length > ro.tools.length);
  for (const w of ['bw_delete', 'bw_run_dtp', 'bw_start_process_chain', 'bw_push_data', 'bw_create_transport_task', 'bw_create_adso']) {
    assert.ok(names.includes(w), `${w} deve esserci`);
  }
  for (const t of full.tools) {
    assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} senza annotazioni`);
  }
  assert.equal(full.tools.find((t) => t.name === 'bw_delete').annotations.destructiveHint, true);
  assert.doesNotMatch(full.init.instructions, /READ-ONLY MODE/);
});
