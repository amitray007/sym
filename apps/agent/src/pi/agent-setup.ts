/**
 * Per-turn assembly of the Pi Agent's inputs: the `AgentTool[]` (bridged
 * built-ins + the on-demand `find_tools` / `call_tool` meta-tools) and the
 * composed system prompt (static base + live connector/CLI catalogs).
 */

import { buildSystemPrompt, buildActivePersonaPrompt, DEFAULT_PERSONA } from '@sym/kernel';

import { requestConfirmation } from '../confirmations.js';
import { logCtx } from '../log.js';
import { buildCliCatalog } from '../run-cli.js';
import { friendlyVerb } from './friendly-verb.js';
import { buildConnectorCatalog, makeCallTool, makeFindTools } from './meta-tools.js';
import { bridgeTools } from './tools.js';

import type { resolveAllowlist, resolveCliCapabilities } from '../run-cli.js';
import type { PiLoopOptions, PiModelCfg } from './loop.js';
import type {
  RenderIntent,
  SlackChannelId,
  SlackThreadTs,
  ToolDescriptor,
  ToolRuntimeContext,
  Turn,
} from '@sym/contracts';
import type { PersonaName, ToolRegistry } from '@sym/kernel';

/** Context objects threaded into the per-turn helper builders. */
export interface TurnHelperCtx {
  turn: Turn;
  modelCfg: PiModelCfg;
  opts: PiLoopOptions;
  registry: ToolRegistry;
  ctx: ToolRuntimeContext;
}

/**
 * Assemble the Pi `AgentTool[]` for one turn: bridged built-ins + the two
 * on-demand meta-tools (`find_tools` / `call_tool`) when MCP or CLI caps exist.
 * Returns the tool list, a parallel `knownToolNames` guard set (for the
 * phantom-tool filter), and the mutable `renders` sink for render intents.
 */
export function buildAgentTools(
  hctx: TurnHelperCtx,
  builtinDescriptors: ToolDescriptor[],
  mcpDescriptors: ToolDescriptor[],
  cliCaps: ReturnType<typeof resolveCliCapabilities>,
): {
  agentTools: ReturnType<typeof bridgeTools>;
  descriptorMap: Map<string, ToolDescriptor>;
  knownToolNames: Set<string>;
  renders: RenderIntent[];
} {
  const { registry, ctx, turn, opts } = hctx;
  const renders: RenderIntent[] = [];
  const onRender = (r: RenderIntent): void => {
    renders.push(r);
  };

  // MCP confirm — call_tool self-gates because the model invokes `call_tool`,
  // not the underlying MCP tool name. Fails CLOSED when channel is unavailable.
  const confirmMcp = async (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ): Promise<boolean> => {
    const channelId = turn.channelId;
    if (!channelId || !opts.slackClient) {
      console.warn(
        `${logCtx(turn.id)} [pi] mcp tool '${toolName}' blocked: confirmation channel unavailable`,
      );
      return false;
    }
    // Reflect the gate on the enclosing call_tool row (shared toolCallId) — the
    // label matches what the subscriber rendered for it ("running <connector>:
    // <tool>") so the row reads consistently from start → awaiting → settle.
    const label = friendlyVerb('call_tool', { name: toolName, arguments: args });
    await opts.onToolGate?.(toolCallId, 'awaiting', label);
    const approved = await requestConfirmation({
      slackClient: opts.slackClient,
      channel: channelId as SlackChannelId,
      ...(turn.threadTs !== undefined ? { threadTs: turn.threadTs as SlackThreadTs } : {}),
      toolName,
      args,
    });
    await opts.onToolGate?.(toolCallId, approved ? 'approved' : 'denied', label);
    return approved;
  };

  const agentTools = [
    ...bridgeTools(registry, ctx, builtinDescriptors, onRender),
    // find_tools searches BOTH MCP tools and CLIs, so it's worth offering whenever
    // either exists. call_tool is MCP-only.
    ...(mcpDescriptors.length > 0 || cliCaps.length > 0
      ? [makeFindTools({ mcp: mcpDescriptors, cli: cliCaps })]
      : []),
    ...(mcpDescriptors.length > 0
      ? [makeCallTool({ mcp: mcpDescriptors, registry, ctx, confirm: confirmMcp, onRender })]
      : []),
  ];

  // beforeToolCall gates only natively-bridged built-ins; MCP confirm lives in call_tool.
  const descriptorMap = new Map<string, ToolDescriptor>(builtinDescriptors.map((d) => [d.name, d]));

  // Tool names the UI status/task-card layer recognises: built-ins + the
  // on-demand meta-tools. find_tools/call_tool are real tool calls but aren't
  // registered descriptors, so they must be listed here or their status gets
  // dropped by the phantom-tool guard.
  const knownToolNames = new Set<string>([
    ...descriptorMap.keys(),
    ...(mcpDescriptors.length > 0 ? ['find_tools', 'call_tool'] : []),
  ]);

  return { agentTools, descriptorMap, knownToolNames, renders };
}

/**
 * Compose the full system prompt for one turn, ordered by VOLATILITY for provider
 * prefix-caching — most-stable first, most-volatile last, so a change late in the
 * prompt never invalidates the cached prefix before it:
 *   1. static base — byte-identical every turn
 *   2. connector catalog + 3. CLI catalog — rebuilt each turn but byte-stable
 *      ACROSS turns unless the connector set / allowlist changes (a rare reconcile)
 *   4. active-persona block — the MOST volatile section (it varies by the
 *      per-channel home and is re-read from an editable spec), so it trails the
 *      catalogs; a voice switch then re-bills only this block, not the catalogs.
 */
export function buildAgentSystemPrompt(
  mcpDescriptors: ToolDescriptor[],
  cliAllowlist: ReturnType<typeof resolveAllowlist>,
  cliCaps: ReturnType<typeof resolveCliCapabilities>,
  persona: PersonaName = DEFAULT_PERSONA,
  personaSpec?: string,
): string {
  const baseSystemPrompt = buildSystemPrompt();
  // Live capability catalogs so the model knows what's reachable THIS turn: MCP
  // connectors (via find_tools/call_tool) + CLIs (via run_cli, with what each is
  // for). Rebuilt per turn but stable across turns while the connector set /
  // allowlist hold; the static prompt still tells the model to introspect
  // (`sym status`/`sym tools`/`find_tools`) rather than trust a cached list.
  const catalog = buildConnectorCatalog(mcpDescriptors);
  const cliCatalog = buildCliCatalog(cliAllowlist, cliCaps);
  // The turn's ACTIVE persona — its full situation-by-situation spec, resolved at
  // the turn boundary (pi/loop): the id from the per-channel override or the
  // SYM_PERSONA home, the spec from a `.sym/personas/<id>.md` override or (when
  // omitted) the shipped default. Most volatile, so it goes LAST (see above).
  const activePersona = buildActivePersonaPrompt(persona, personaSpec);
  return [baseSystemPrompt, catalog, cliCatalog, activePersona]
    .filter((s) => s.length > 0)
    .join('\n\n');
}
