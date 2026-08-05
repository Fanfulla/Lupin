#!/usr/bin/env node
// MCP server fixture per `lupin doctor` (SPEC-CLI §3, check 5).
// Un solo tool, `echo_test`: registrato da Claude Code col nome lungo
// `mcp__lupin_doctor__echo_test`, il formato che rompe i modelli terzi.
// Stdio JSON-RPC minimale, zero dipendenze: non e' un SDK, e' una fixture.

import { createInterface } from 'node:readline';

const TOOL = {
  name: 'echo_test',
  description: 'Echoes back the given text, prefixed with "echo:". Test tool for lupin doctor.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to echo back' } },
    required: ['text'],
  },
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lupin_doctor', version: '0.1.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [TOOL] });
  } else if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? '';
    reply(msg.id, { content: [{ type: 'text', text: `echo:${text}` }] });
  } else if (msg.id !== undefined) {
    // unknown request: empty result keeps the handshake alive
    reply(msg.id, {});
  }
  // notifications (no id) are ignored
});
