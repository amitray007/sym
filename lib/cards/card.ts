import {
  cardToSlackBlocks,
  cardToSlackFallbackText,
  SlackBlockError,
  type SlackCardElement,
} from "@chat-adapter/slack/blocks";
import { CardSpecError, schema, standardComponentDefinitions, toCard } from "@json-render/chat";
import { defineCatalog } from "@json-render/core";
import type { z } from "zod";
import { defuse } from "../jobs/blocks.ts";
import { buttonUrl } from "../jobs/card.ts";

// Generative cards (decision 095). The brain fills a json-render spec from a fixed catalog;
// code validates it and renders Slack Block Kit. Action buttons and images stay out: Sym has no
// handler for a card button, and choices go through offer_choices.
const { Card, Section, Text, Fields, Field, Table, Chart, Divider, Actions, LinkButton } =
  standardComponentDefinitions;
const components = {
  Card: { ...Card, props: Card.props.omit({ imageUrl: true }) },
  Section,
  Text,
  Fields,
  Field,
  Table,
  Chart,
  Divider,
  Actions: { ...Actions, description: "Row of LinkButton elements." },
  LinkButton,
};

const catalog = defineCatalog(schema, { components });

/** The tool input: a flat `{ root, elements }` spec whose element types come from the catalog. */
export const CardSpec = catalog.zodSchema();

// Slack's limits, as the Slack adapter applies them. Past most of them the adapter turns a chart or
// table into a code block or cuts text without an error, so code refuses the spec instead and
// returns the reason. A data table paginates, so its row cap is Slack's (100 rows including the
// header), not the display rule's 10-row document threshold.
const LIMITS = {
  tables: 1,
  charts: 2,
  fields: 10,
  tableRows: 100,
  tableColumns: 20,
  chartTitle: 50,
  chartLabel: 20,
  chartSeries: 12,
  chartPoints: 20,
};
const MAX_BLOCKS = 50;
const TEXT_MAX = { title: 150, text: 3000, field: 1900, button: 75, tableCells: 10000 };

/** The catalog's own one-line description of each component and its props. */
export const COMPONENT_GUIDE = componentLines(catalog.prompt());

function componentLines(prompt: string): string {
  return prompt
    .split("\n")
    .filter((line) => Object.keys(components).some((name) => line.startsWith(`- ${name}: {`)))
    .join("\n");
}

export type RenderedCard =
  | { ok: true; text: string; blocks: Record<string, unknown>[] }
  | { ok: false; issues: string[] };

/** Validates a spec and renders it as Block Kit plus the notification text. */
export function renderCard(spec: unknown): RenderedCard {
  const parsed = CardSpec.safeParse(spec);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(issueText) };
  const issues = [
    ...dynamicParts(parsed.data),
    ...unsafeLinks(parsed.data),
    ...duplicateLinks(parsed.data),
    ...longText(parsed.data),
  ];
  if (issues.length > 0) return { ok: false, issues };
  try {
    // The `/blocks` entry types its own card shape, which matches Chat SDK's CardElement except
    // for optional-property strictness. It keeps the adapter's Slack client out of the bundle.
    const card = toCard(prepare(parsed.data), {
      components,
      limits: LIMITS,
    }) as SlackCardElement;
    // The adapter cuts blocks past its cap without an error, so ask for one more to detect it.
    const blocks = cardToSlackBlocks(card, { maxBlocks: MAX_BLOCKS + 1 });
    if (blocks.length > MAX_BLOCKS)
      return { ok: false, issues: [`the card needs more than ${MAX_BLOCKS} Slack blocks`] };
    const lost = degraded(parsed.data, blocks);
    if (lost.length > 0) return { ok: false, issues: lost };
    return { ok: true, text: cardToSlackFallbackText(card), blocks: linkIds(blocks) };
  } catch (error) {
    if (error instanceof CardSpecError) return { ok: false, issues: error.issues };
    if (error instanceof SlackBlockError) return { ok: false, issues: [error.message] };
    throw error;
  }
}

function issueText(issue: { path: PropertyKey[]; message: string }): string {
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

type Spec = z.infer<typeof CardSpec>;

// Sym passes no state, so expressions, repeat, and visible would render nothing. Rejecting them
// also keeps every string literal, so defusing the spec before rendering covers all card text.
function dynamicParts(spec: Spec): string[] {
  return Object.entries(spec.elements).flatMap(([id, element]) => [
    ...(element.repeat === undefined ? [] : [`${id}.repeat: list each item as its own element`]),
    ...(element.visible === undefined ? [] : [`${id}.visible: leave out what should not show`]),
    ...(hasExpression(element.props) ? [`${id}.props: use literal values, not $ expressions`] : []),
  ]);
}

function hasExpression(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExpression);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => key.startsWith("$") || hasExpression(item));
}

function unsafeLinks(spec: Spec): string[] {
  return Object.entries(spec.elements)
    .filter(([, element]) => element.type === "LinkButton")
    .filter(([, element]) => !buttonUrl(String(element.props.url ?? "")))
    .map(([id]) => `${id}.props.url: use a full http or https link`);
}

// The adapter names a link button `link-<url>`, so two buttons with one URL would share an
// action_id and Slack would refuse the message.
function duplicateLinks(spec: Spec): string[] {
  const seen = new Set<string>();
  return Object.entries(spec.elements)
    .filter(([, element]) => element.type === "LinkButton")
    .flatMap(([id, element]) => {
      const url = String(element.props.url ?? "");
      if (seen.has(url)) return [`${id}.props.url: each link button needs its own link`];
      seen.add(url);
      return [];
    });
}

// The adapter cuts text past Slack's limits without an error, so longer text is refused.
function longText(spec: Spec): string[] {
  const issues: string[] = [];
  const check = (id: string, prop: string, value: unknown, max: number) => {
    if (String(value ?? "").length > max)
      issues.push(`${id}.props.${prop}: at most ${max} characters`);
  };
  for (const [id, { type, props }] of Object.entries(spec.elements)) {
    if (type === "Card") check(id, "title", props.title, TEXT_MAX.title);
    if (type === "Card") check(id, "subtitle", props.subtitle, TEXT_MAX.text);
    if (type === "Text") check(id, "content", props.content, TEXT_MAX.text);
    if (type === "Field") check(id, "value", `${props.label}${props.value}`, TEXT_MAX.field);
    if (type === "LinkButton") check(id, "label", props.label, TEXT_MAX.button);
    if (type === "Table") {
      const cells = [props.headers, ...((props.rows as unknown[]) ?? [])].flat();
      const length = cells.reduce((sum: number, cell) => sum + String(cell ?? "").length, 0);
      if (length > TEXT_MAX.tableCells)
        issues.push(`${id}: at most ${TEXT_MAX.tableCells} characters across all cells`);
    }
  }
  return issues;
}

// The adapter turns a chart or table that Slack can't draw into a code block. Count what it drew
// and refuse the card when something became text.
function degraded(spec: Spec, blocks: Record<string, unknown>[]): string[] {
  const used = reachable(spec);
  const count = (type: string) => used.filter((element) => element.type === type).length;
  const drawn = (...types: string[]) =>
    blocks.filter((block) => types.includes(String(block.type))).length;
  return [
    ...(drawn("data_visualization") < count("Chart")
      ? [
          "a Chart could not become a Slack chart: give each one a title, unique category and " +
            "series names, one value per category in each series, and pie values above 0",
        ]
      : []),
    ...(drawn("data_table", "table") < count("Table")
      ? ["the Table could not become a Slack table: give every row one cell per header"]
      : []),
  ];
}

function reachable(spec: Spec): Spec["elements"][string][] {
  const found: Spec["elements"][string][] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const element = spec.elements[id];
    if (!element || seen.has(id)) return;
    seen.add(id);
    found.push(element);
    for (const child of element.children ?? []) visit(child);
  };
  visit(spec.root);
  return found;
}

// Give each link button its own action_id. Sym's action handler ignores these clicks, and the
// adapter's URL-based ids can collide when it cuts long URLs.
function linkIds(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  let n = 0;
  return blocks.map((block) =>
    block.type === "actions" && Array.isArray(block.elements)
      ? {
          ...block,
          elements: block.elements.map((element: Record<string, unknown>) =>
            element.url ? { ...element, action_id: `sym_card_link_${n++}` } : element,
          ),
        }
      : block,
  );
}

// Card text must not ping a channel or a person, the same as every other Sym post. Only element
// props are card text; ids stay as written so children still match their keys. A link button's
// URL is not message text, and unsafeLinks already checked it.
function prepare(spec: Spec): Spec {
  const elements = Object.fromEntries(
    Object.entries(spec.elements).map(([id, element]) => {
      const { url, ...rest } = element.props as Record<string, unknown>;
      const props = defuseStrings(element.type === "LinkButton" ? rest : element.props);
      if (element.type === "LinkButton") return [id, { ...element, props: { ...props, url } }];
      if (element.type === "Text")
        return [
          id,
          { ...element, props: { ...props, content: slackLinks(String(props.content)) } },
        ];
      return [id, { ...element, props }];
    }),
  );
  return { ...spec, elements } as Spec;
}

// Slack mrkdwn has no [label](url) links, so they would post as brackets. Turn http(s) links into
// Slack's <url|label> form.
function slackLinks(text: string): string {
  return text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s()<>|]+)\)/g,
    (_, label: string, url: string) => `<${url}|${label.replace(/[<>|]/g, "")}>`,
  );
}

function defuseStrings<T>(value: T): T {
  if (typeof value === "string") return defuse(value) as T;
  if (Array.isArray(value)) return value.map(defuseStrings) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, defuseStrings(item)]),
    ) as T;
  }
  return value;
}
