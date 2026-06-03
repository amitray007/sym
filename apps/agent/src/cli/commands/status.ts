/**
 * `sym status` — agent reachability + every connector's health + tool counts.
 */

import { configPath } from '@sym/mcp-runtime';

import { isCliWildcard, resolveCliConnectors } from '../../run-cli.js';
import { fetchConnectors, type ConnectorDetail } from '../admin-client.js';
import { cliConnectorLines, offlineDetails, renderConnectorTable } from './render.js';

/** `sym status` — agent reachability + every connector's health + tool counts. */
export async function statusCommand(json: boolean): Promise<number> {
  let connectors: ConnectorDetail[];
  let reachable: boolean;
  try {
    connectors = await fetchConnectors();
    reachable = true;
  } catch {
    reachable = false;
    connectors = offlineDetails();
  }
  const totalTools = connectors.reduce((sum, c) => sum + c.tools, 0);

  if (json) {
    console.log(
      JSON.stringify(
        {
          reachable,
          configPath: configPath(),
          totalTools,
          connectorCount: connectors.length,
          connectors,
          cli: { connectors: resolveCliConnectors(), wildcard: isCliWildcard() },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(
    `agent: ${reachable ? 'up' : 'down'}   config: ${configPath()}   ` +
      `${totalTools} tool(s) live across ${connectors.length} connector(s)` +
      (reachable ? '' : '   (offline view — start Sym for live health/tools)'),
  );
  console.log(renderConnectorTable(connectors));
  console.log('\nCLIs (run_cli):');
  for (const line of cliConnectorLines()) console.log(line);
  return 0;
}
