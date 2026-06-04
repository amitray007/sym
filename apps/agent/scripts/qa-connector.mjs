// QA harness — drive Sym's REAL MCP client against the servers in SYM_MCP_SERVERS.
//
// Exercises the full parse -> connect -> listTools -> (optional) dispatch path
// over the real wire (spawns stdio subprocesses / opens http transports), using
// the same compiled modules the agent runs. This is the on-demand "is it
// actually working?" check — not a mocked unit test.
//
// Usage:
//   SYM_MCP_SERVERS='[{"name":"x","transport":{"kind":"stdio","command":"npx","args":["-y","@shopify/dev-mcp@latest"]},"trust":true}]' \
//     pnpm --filter @sym/agent qa:mcp
//
// Optional single tool call (proves the dispatch path too):
//   SYM_QA_TOOL='x__search_docs_chunks' SYM_QA_ARGS='{"prompt":"hello"}' ... pnpm --filter @sym/agent qa:mcp
//
// Slow first run (cold `npx` download) — bump SYM_MCP_CONNECT_TIMEOUT_MS, e.g. 60000.
import { parseMcpServers, McpDispatcher } from '@sym/mcp-runtime';

const raw = process.env.SYM_MCP_SERVERS;
if (raw === undefined || raw.trim() === '') {
  console.error('[qa] set SYM_MCP_SERVERS to a JSON array of connector configs');
  process.exit(1);
}

const configs = parseMcpServers(raw);
console.log(
  `[qa] parsed ${configs.length} connector(s): ${configs.map((c) => c.name).join(', ') || '(none)'}`,
);
if (configs.length === 0) {
  console.error(
    '[qa] FAIL: no connectors parsed — check the SYM_MCP_SERVERS shape and the [mcp] warnings above',
  );
  process.exit(2);
}

const dispatcher = new McpDispatcher(configs);
console.log('[qa] connecting + listing tools (real transports)...');
const tools = await dispatcher.listAsync();
console.log(`[qa] ${tools.length} tool(s) discovered:`);
for (const t of tools) {
  const gate = t.destructiveHint === true ? 'confirm-gated' : 'trusted';
  console.log(
    `   • ${t.name} [${gate}] — ${(t.description ?? '').replace(/\s+/g, ' ').slice(0, 80)}`,
  );
}

let dispatchLabel = '';
const toolName = process.env.SYM_QA_TOOL;
if (toolName !== undefined && toolName !== '') {
  let args = {};
  if (process.env.SYM_QA_ARGS !== undefined) {
    try {
      args = JSON.parse(process.env.SYM_QA_ARGS);
    } catch {
      console.error('[qa] SYM_QA_ARGS is not valid JSON');
      process.exit(3);
    }
  }
  console.log(`[qa] dispatching ${toolName} ${JSON.stringify(args)}`);
  const res = await dispatcher.dispatch({ id: 'qa', name: toolName, arguments: args }, {});
  if (res.ok) {
    console.log('[qa] result (first 700 chars):\n' + String(res.content).slice(0, 700));
    dispatchLabel = ' | dispatch: PASS';
  } else {
    console.log('[qa] error result:', JSON.stringify(res.error));
    dispatchLabel = ' | dispatch: error-result (path works; tool/args may differ)';
  }
}

const listLabel =
  tools.length > 0 ? 'PASS' : 'WARN (0 tools — connect failed/timed-out or server needs auth)';
console.log(`\n[qa] SUMMARY — parse: PASS | connect+list: ${listLabel}${dispatchLabel}`);
process.exit(tools.length > 0 ? 0 : 4);
