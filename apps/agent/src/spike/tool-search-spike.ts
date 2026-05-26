/**
 * tool-search-spike.ts — Spike: dynamic tool discovery ("search_tools") against Fireworks.
 *
 * GOAL
 * ----
 * Validate two unknowns before committing to dynamic tool discovery:
 *
 *   1. Pi mechanics — does Pi re-read `agent.state.tools` on each step (so
 *      pushing tools mid-run gives the model native tool schemas for the next
 *      turn), or must we use a generic `call_tool(name, args)` dispatcher?
 *
 *   2. Model capability — can the Fireworks/open-weight model reliably do the
 *      search → read → call hop?
 *
 * WHAT THE CODE DOES
 * ------------------
 * Defines 3 FAKE tools (hidden from the model's initial tool list):
 *   - get_weather({city})          — returns canned weather string
 *   - convert_currency({amount, from, to}) — returns canned FX string
 *   - roll_dice({sides})           — returns canned dice roll string
 *
 * Exposes a `search_tools({query})` meta-tool (present from the start) that
 * keyword-matches the 3 fake tools and returns matches.
 *
 * Two modes (set via env SPIKE_MODE):
 *
 *   native   (default) — on search_tools result, push the matched AgentTool(s)
 *                        into agent.state.tools and let Pi present them to the
 *                        model on the next turn natively. Tests Pi's mid-run
 *                        tool mutation behaviour.
 *
 *   dispatch            — also expose `call_tool({name, args})` from the start.
 *                        The model searches, then calls call_tool to invoke a
 *                        hidden tool by name via a dispatcher. Tests the
 *                        "always works regardless of Pi internals" path.
 *
 * The harness drives the agent with a prompt that needs two hidden tools:
 *   "What's the weather in Tokyo, and roll a 20-sided die. Use your tools."
 *
 * READING THE LOG
 * ---------------
 * The owner should look for (in order):
 *   [TOOL CALL] search_tools        { query: ... }       ← model discovers tools
 *   [TOOL RESULT] search_tools      ...                  ← matches returned
 *
 *   native mode:
 *     [SPIKE] pushed N tool(s) into agent.state.tools    ← mid-run mutation
 *     [TOOL CALL] get_weather       { city: "Tokyo" }    ← native call works?
 *     [TOOL CALL] roll_dice         { sides: 20 }
 *
 *   dispatch mode:
 *     [TOOL CALL] call_tool         { name: "get_weather", args: ... }
 *     [TOOL CALL] call_tool         { name: "roll_dice",   args: ... }
 *
 *   [SUMMARY] at end: search called? correct tools called? args correct?
 *
 * ADDITIVE ONLY — does not touch any production path.
 *
 * Run via:
 *   pnpm --filter @sym/agent spike:toolsearch
 *   SPIKE_MODE=dispatch pnpm --filter @sym/agent spike:toolsearch
 *
 * Requires .env with DATABASE_URL (+ secrets key ring) OR FIREWORKS_API_KEY.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent } from '@earendil-works/pi-agent-core';
import { createDb, providerConfigs } from '@sym/db';
import { buildSystemPrompt } from '@sym/kernel';
import { initSecrets } from '@sym/secrets';
import { config as loadDotenv } from 'dotenv';
import { and, eq } from 'drizzle-orm';

import { buildFireworksModel } from '../pi/model.js';

import type { AgentEvent, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
loadDotenv({ path: resolve(repoRoot, '.env') });

// Default is `dispatch`: the spike confirmed Fireworks does search→call_tool
// cleanly, while `native` (mid-run state.tools mutation) is blocked by Pi's
// run-start snapshot. Pass SPIKE_MODE=native to re-confirm the native finding.
const SPIKE_MODE = (process.env['SPIKE_MODE'] ?? 'dispatch') as 'native' | 'dispatch';

// ---------------------------------------------------------------------------
// Fireworks config loader (identical to pi-spike.ts)
// ---------------------------------------------------------------------------

interface FireworksConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  source: 'db' | 'env';
}

async function resolveFireworksConfig(): Promise<FireworksConfig> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl) {
    try {
      await initSecrets();
      const { db, close } = createDb(databaseUrl);

      const row = (
        await db
          .select()
          .from(providerConfigs)
          .where(and(eq(providerConfigs.provider, 'fireworks'), eq(providerConfigs.enabled, true)))
          .limit(1)
      )[0];

      await close();

      if (row) {
        return {
          baseUrl: row.baseUrl ?? 'https://api.fireworks.ai/inference/v1',
          apiKey: row.apiKey,
          modelId: row.modelChat,
          source: 'db',
        };
      }

      console.warn('[spike] No enabled Fireworks config in DB; falling back to env vars.');
    } catch (err) {
      console.warn('[spike] DB load failed; falling back to env vars:', err);
    }
  }

  const apiKey = process.env['FIREWORKS_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'No Fireworks config found: set DATABASE_URL (with a providerConfigs row) ' +
        'or set FIREWORKS_API_KEY + FIREWORKS_BASE_URL + FIREWORKS_MODEL.',
    );
  }

  return {
    baseUrl: process.env['FIREWORKS_BASE_URL'] ?? 'https://api.fireworks.ai/inference/v1',
    apiKey,
    modelId: process.env['FIREWORKS_MODEL'] ?? 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    source: 'env',
  };
}

// ---------------------------------------------------------------------------
// Fake tool definitions (hidden — not in initial tool list)
// ---------------------------------------------------------------------------

interface FakeToolSpec {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: any; // plain JSON Schema
  execute: (args: Record<string, unknown>) => string;
}

const FAKE_TOOLS_REGISTRY: FakeToolSpec[] = [
  {
    name: 'get_weather',
    description:
      'Get the current weather for a city. Input: city name. Output: temperature and conditions.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'The city to get weather for' },
      },
      required: ['city'],
      additionalProperties: false,
    },
    execute: (args) => {
      const city = String(args['city'] ?? 'Unknown');
      const canned: Record<string, string> = {
        tokyo: 'Tokyo: 18°C, clear skies',
        london: 'London: 12°C, overcast',
        'new york': 'New York: 22°C, sunny',
        paris: 'Paris: 15°C, partly cloudy',
      };
      return canned[city.toLowerCase()] ?? `${city}: 20°C, conditions unknown`;
    },
  },
  {
    name: 'convert_currency',
    description:
      'Convert an amount from one currency to another. Inputs: amount, from (ISO code), to (ISO code).',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'The amount to convert' },
        from: { type: 'string', description: 'Source currency ISO code (e.g. USD)' },
        to: { type: 'string', description: 'Target currency ISO code (e.g. EUR)' },
      },
      required: ['amount', 'from', 'to'],
      additionalProperties: false,
    },
    execute: (args) => {
      const amount = Number(args['amount'] ?? 0);
      const from = String(args['from'] ?? '?').toUpperCase();
      const to = String(args['to'] ?? '?').toUpperCase();
      // Canned FX rate: 1 USD = 0.92 EUR, 1 USD = 149 JPY
      const rates: Record<string, number> = { USD: 1, EUR: 0.92, JPY: 149, GBP: 0.79 };
      const fromRate = rates[from] ?? 1;
      const toRate = rates[to] ?? 1;
      const result = ((amount / fromRate) * toRate).toFixed(2);
      return `${amount} ${from} = ${result} ${to} (canned rate)`;
    },
  },
  {
    name: 'roll_dice',
    description: 'Roll a single N-sided die and return the result. Input: sides (number of faces).',
    parameters: {
      type: 'object',
      properties: {
        sides: { type: 'integer', description: 'Number of sides on the die (e.g. 6, 20, 100)' },
      },
      required: ['sides'],
      additionalProperties: false,
    },
    execute: (args) => {
      const sides = Math.max(1, Math.floor(Number(args['sides'] ?? 6)));
      // Seeded-ish for reproducibility: use Date.now() but log it
      const roll = Math.floor(Math.random() * sides) + 1;
      return `🎲 Rolled a d${sides}: got ${roll}`;
    },
  },
];

// ---------------------------------------------------------------------------
// Build an AgentTool from a FakeToolSpec
// ---------------------------------------------------------------------------

function buildFakeAgentTool(spec: FakeToolSpec): AgentTool {
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters as unknown as TSchema,
    // Bypass TypeBox validation — args come in as plain objects from the model
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments: (args: unknown) => args as any,
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      const args = params as Record<string, unknown>;
      const text = spec.execute(args);
      return {
        content: [{ type: 'text', text }],
        details: { tool: spec.name, args },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher for call_tool (dispatch mode)
// ---------------------------------------------------------------------------

function dispatchFakeTool(name: string, args: Record<string, unknown>): string {
  const spec = FAKE_TOOLS_REGISTRY.find((t) => t.name === name);
  if (!spec) {
    return `Error: unknown tool "${name}". Available: ${FAKE_TOOLS_REGISTRY.map((t) => t.name).join(', ')}`;
  }
  return spec.execute(args);
}

// ---------------------------------------------------------------------------
// Build the initial tool set depending on mode
// ---------------------------------------------------------------------------

function buildInitialTools(agent: Agent): AgentTool[] {
  // search_tools is always present from the start.
  // In native mode: it mutates agent.state.tools when matches are found.
  // In dispatch mode: call_tool is also present; search_tools still returns info.

  const searchToolsTool: AgentTool = {
    name: 'search_tools',
    label: 'search_tools',
    description:
      'Search available tools by keyword. Returns matching tool names, descriptions, and how to call them. ' +
      'Use this when you need a capability that is not already available in your tool list.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A keyword or phrase describing the capability you need (e.g. "weather", "dice", "currency")',
        },
      },
      required: ['query'],
      additionalProperties: false,
    } as unknown as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments: (args: unknown) => args as any,
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      const { query } = params as { query: string };
      const q = query.toLowerCase();

      // Keyword match against name + description
      const matches = FAKE_TOOLS_REGISTRY.filter(
        (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
      );

      if (matches.length === 0) {
        const text = `No tools matched "${query}". Available tools to search: ${FAKE_TOOLS_REGISTRY.map((t) => t.name).join(', ')}`;
        return { content: [{ type: 'text', text }], details: { query, matches: [] } };
      }

      // In NATIVE mode: push matched AgentTool(s) into agent.state.tools so the
      // model can call them natively on the next turn.
      if (SPIKE_MODE === 'native') {
        const matched = matches.map(buildFakeAgentTool);
        // Mutate: add any newly discovered tools (avoid duplicates by name)
        const current = agent.state.tools;
        const existingNames = new Set(current.map((t) => t.name));
        const novel = matched.filter((t) => !existingNames.has(t.name));
        if (novel.length > 0) {
          agent.state.tools = [...current, ...novel];
          console.log(
            `\n[SPIKE] pushed ${novel.length} tool(s) into agent.state.tools: ${novel.map((t) => t.name).join(', ')}`,
          );
          console.log(
            `[SPIKE] agent.state.tools now has ${agent.state.tools.length} tool(s): ${agent.state.tools.map((t) => t.name).join(', ')}`,
          );
        } else {
          console.log(
            `\n[SPIKE] all ${matched.length} matched tool(s) already in agent.state.tools`,
          );
        }
      }

      const description = matches
        .map(
          (t) =>
            `• ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters.properties ?? {})}`,
        )
        .join('\n\n');

      const modeNote =
        SPIKE_MODE === 'native'
          ? '\nThese tools have been registered and are now available for you to call directly by name.'
          : '\nTo use one of these tools, call call_tool with name and args.';

      const text = `Found ${matches.length} tool(s) matching "${query}":\n\n${description}${modeNote}`;

      return {
        content: [{ type: 'text', text }],
        details: { query, matches: matches.map((t) => t.name) },
      };
    },
  };

  const callToolTool: AgentTool = {
    name: 'call_tool',
    label: 'call_tool',
    description:
      'Invoke a tool by name with given arguments. Use this after search_tools to call a discovered tool.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool name returned by search_tools' },
        args: {
          type: 'object',
          description: 'The arguments to pass to the tool (as a JSON object)',
          additionalProperties: true,
        },
      },
      required: ['name', 'args'],
      additionalProperties: false,
    } as unknown as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments: (a: unknown) => a as any,
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      const { name, args } = params as { name: string; args: Record<string, unknown> };
      const text = dispatchFakeTool(name, args);
      return {
        content: [{ type: 'text', text }],
        details: { tool: name, args },
      };
    },
  };

  const tools: AgentTool[] = [searchToolsTool];
  if (SPIKE_MODE === 'dispatch') {
    tools.push(callToolTool);
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Trajectory tracker (what the owner reads)
// ---------------------------------------------------------------------------

interface TrajectoryEntry {
  kind: 'tool_call' | 'tool_result' | 'text';
  name?: string;
  args?: unknown;
  result?: string;
  text?: string;
}

const trajectory: TrajectoryEntry[] = [];
let finalText = '';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const TEST_PROMPT = "What's the weather in Tokyo, and roll a 20-sided die. Use your tools.";

async function main(): Promise<void> {
  const fwConfig = await resolveFireworksConfig();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  TOOL-SEARCH SPIKE');
  console.log(`  Mode:     SPIKE_MODE=${SPIKE_MODE}`);
  console.log(`  Config:   ${fwConfig.source}`);
  console.log(`  Model:    ${fwConfig.modelId}`);
  console.log(`  BaseURL:  ${fwConfig.baseUrl}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Prompt: "${TEST_PROMPT}"`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const model = buildFireworksModel({
    baseUrl: fwConfig.baseUrl,
    modelId: fwConfig.modelId,
  });

  const systemPrompt = buildSystemPrompt();

  // Build the agent first (needed for the closure in searchToolsTool)
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: [], // placeholder — will be set below after agent is constructed
    },
    getApiKey: (_provider: string) => fwConfig.apiKey,
  });

  // Now build initial tools (the search tool closure captures `agent`)
  const initialTools = buildInitialTools(agent);
  agent.state.tools = initialTools;

  console.log(`[SPIKE] Initial tools: ${initialTools.map((t) => t.name).join(', ')}`);
  console.log(`[SPIKE] Hidden tools:  ${FAKE_TOOLS_REGISTRY.map((t) => t.name).join(', ')}`);
  console.log('');

  // -------------------------------------------------------------------------
  // Subscribe to events — log the trajectory clearly
  // -------------------------------------------------------------------------

  agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'agent_start':
        console.log('[EVENT] agent_start');
        break;

      case 'turn_start':
        console.log('[EVENT] turn_start');
        break;

      case 'turn_end':
        console.log('[EVENT] turn_end');
        break;

      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        break;

      case 'message_end':
        if (event.message.role === 'assistant') {
          // Flush newline after streaming text
          process.stdout.write('\n');
          // Capture final text from the last content block
          if ('content' in event.message) {
            const textBlocks = event.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { type: string; text?: string }) => b.text ?? '')
              .join('');
            if (textBlocks.length > 0) {
              finalText = textBlocks;
              trajectory.push({ kind: 'text', text: textBlocks });
            }
          }
        }
        break;

      case 'tool_execution_start': {
        const argsStr = JSON.stringify(event.args ?? {});
        console.log(`\n[TOOL CALL] ${event.toolName.padEnd(22)} ${argsStr}`);
        trajectory.push({ kind: 'tool_call', name: event.toolName, args: event.args });
        break;
      }

      case 'tool_execution_end': {
        const resultText = Array.isArray(event.result?.content)
          ? event.result.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { type: string; text?: string }) => b.text ?? '')
              .join(' ')
          : String(event.result ?? '');
        console.log(`[TOOL RESULT] ${event.toolName.padEnd(20)} ${resultText.slice(0, 120)}`);
        trajectory.push({ kind: 'tool_result', name: event.toolName, result: resultText });
        break;
      }

      case 'agent_end':
        console.log('[EVENT] agent_end\n');
        break;
    }
  });

  // -------------------------------------------------------------------------
  // Run the agent
  // -------------------------------------------------------------------------

  console.log('[SPIKE] Starting agent.prompt()...\n');
  await agent.prompt(TEST_PROMPT);

  // -------------------------------------------------------------------------
  // SUMMARY — the owner reads this to judge success
  // -------------------------------------------------------------------------

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SPIKE SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Mode: SPIKE_MODE=${SPIKE_MODE}`);
  console.log('');

  const toolCalls = trajectory.filter((e) => e.kind === 'tool_call');
  const toolResults = trajectory.filter((e) => e.kind === 'tool_result');

  const calledSearch = toolCalls.some((e) => e.name === 'search_tools');
  const calledGetWeather = toolCalls.some((e) => e.name === 'get_weather');
  const calledRollDice = toolCalls.some((e) => e.name === 'roll_dice');
  const calledCallTool = toolCalls.some((e) => e.name === 'call_tool');

  // In dispatch mode: check that call_tool was called with the right names
  const callToolForWeather = toolCalls.some(
    (e) => e.name === 'call_tool' && (e.args as { name?: string })?.name === 'get_weather',
  );
  const callToolForDice = toolCalls.some(
    (e) => e.name === 'call_tool' && (e.args as { name?: string })?.name === 'roll_dice',
  );

  // Arg checks
  const weatherArgs = toolCalls.find((e) => e.name === 'get_weather')?.args as
    | { city?: string }
    | undefined;
  const diceArgs = toolCalls.find((e) => e.name === 'roll_dice')?.args as
    | { sides?: number }
    | undefined;
  const weatherArgsViaDispatch = toolCalls.find(
    (e) => e.name === 'call_tool' && (e.args as { name?: string })?.name === 'get_weather',
  )?.args as { name?: string; args?: { city?: string } } | undefined;
  const diceArgsViaDispatch = toolCalls.find(
    (e) => e.name === 'call_tool' && (e.args as { name?: string })?.name === 'roll_dice',
  )?.args as { name?: string; args?: { sides?: number } } | undefined;

  console.log('  Tool call trajectory:');
  for (const e of toolCalls) {
    const check = e.name === 'search_tools' ? '  (meta)' : '  (hidden)';
    console.log(`    [CALL] ${e.name}${check}  args=${JSON.stringify(e.args)}`);
  }
  console.log('');

  console.log('  Judgement:');
  console.log(`    search_tools called?               ${calledSearch ? 'YES ✓' : 'NO ✗'}`);

  if (SPIKE_MODE === 'native') {
    console.log(`    get_weather called natively?       ${calledGetWeather ? 'YES ✓' : 'NO ✗'}`);
    console.log(`    roll_dice called natively?         ${calledRollDice ? 'YES ✓' : 'NO ✗'}`);
    console.log(
      `    weather city arg correct?          ${weatherArgs?.city ? `YES ✓ (city="${weatherArgs.city}")` : 'NO ✗ (missing or wrong)'}`,
    );
    console.log(
      `    dice sides arg correct?            ${diceArgs?.sides ? `YES ✓ (sides=${diceArgs.sides})` : 'NO ✗ (missing or wrong)'}`,
    );
    console.log('');
    console.log('  Pi mid-run mutation verdict:');
    if (calledGetWeather || calledRollDice) {
      console.log('    Pi DOES re-read state.tools per turn — native dynamic registration WORKS.');
      console.log('    The context snapshot in createContextSnapshot() is taken fresh each call.');
    } else {
      console.log('    Pi does NOT use mutated state.tools mid-run — native mode FAILED.');
      console.log('    The loop captured a snapshot at run-start and ignores later mutations.');
      console.log('    → Recommendation: use SPIKE_MODE=dispatch (call_tool dispatcher).');
    }
  } else {
    console.log(`    call_tool called?                  ${calledCallTool ? 'YES ✓' : 'NO ✗'}`);
    console.log(`    call_tool→get_weather?             ${callToolForWeather ? 'YES ✓' : 'NO ✗'}`);
    console.log(`    call_tool→roll_dice?               ${callToolForDice ? 'YES ✓' : 'NO ✗'}`);
    console.log(
      `    weather city via dispatch?         ${weatherArgsViaDispatch?.args?.city ? `YES ✓ (city="${weatherArgsViaDispatch.args.city}")` : 'NO ✗ (missing or wrong)'}`,
    );
    console.log(
      `    dice sides via dispatch?           ${diceArgsViaDispatch?.args?.sides ? `YES ✓ (sides=${diceArgsViaDispatch.args.sides})` : 'NO ✗ (missing or wrong)'}`,
    );
  }

  console.log('');
  console.log('  Final assistant text:');
  const preview = finalText.slice(0, 300);
  console.log(`    "${preview}${finalText.length > 300 ? '...' : ''}"`);
  console.log('');

  const toolResultSummary = toolResults
    .map((r) => `    ${r.name}: ${String(r.result ?? '').slice(0, 80)}`)
    .join('\n');
  console.log('  Tool results:');
  console.log(toolResultSummary || '    (none)');
  console.log('');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Copy this SUMMARY block and paste it back to evaluate.');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch((err: unknown) => {
  console.error('[spike] fatal:', err);
  process.exit(1);
});
