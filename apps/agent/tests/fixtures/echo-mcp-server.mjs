/**
 * Fixture: echo-mcp-server.mjs
 *
 * A minimal MCP server over stdio that exposes tools for observing what the
 * child process actually received via env injection + file pointer injection.
 *
 * Uses the low-level Server API (not McpServer) to avoid Zod dependency in
 * the fixture — the low-level API accepts plain JSON Schema for tool descriptors.
 *
 * Tools:
 *   get_env       — returns process.env[NAME] for the given NAME argument
 *   read_cred_file — reads the file at process.env.GOOGLE_APPLICATION_CREDENTIALS
 *
 * Imports use bare specifiers — Node resolves them relative to THIS file's
 * location (apps/agent/node_modules), independent of the working directory the
 * script is spawned from. (A previous hardcoded absolute path broke CI.)
 *
 * @see apps/agent/tests/mcp.integration.test.ts
 */

import { readFile } from 'node:fs/promises';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'echo-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: 'get_env',
    description: 'Returns the value of a named environment variable in this child process',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The env-var name to look up' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_cred_file',
    description:
      'Reads and returns the contents of the file at process.env.GOOGLE_APPLICATION_CREDENTIALS',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'get_env') {
    const envName = (args ?? {})['name'];
    const value =
      typeof envName === 'string' ? (process.env[envName] ?? '(not set)') : '(invalid name arg)';
    return { content: [{ type: 'text', text: value }] };
  }

  if (name === 'read_cred_file') {
    const filePath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    if (!filePath) {
      return { content: [{ type: 'text', text: '(GOOGLE_APPLICATION_CREDENTIALS not set)' }] };
    }
    try {
      const content = await readFile(filePath, 'utf-8');
      return { content: [{ type: 'text', text: content }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `ERROR: ${String(err)}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
