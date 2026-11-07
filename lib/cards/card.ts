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

// Slack allows one data table and two charts in a message. A data table paginates, so the cap on
// rows is Slack's, not the display rule's 10-row document threshold.
const LIMITS = { tables: 1, charts: 2, tableRows: 100 };
const MAX_BLOCKS = 50;

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
  const issues = [...dynamicParts(parsed.data), ...unsafeLinks(parsed.data)];
  if (issues.length > 0) return { ok: false, issues };
  try {
    // The `/blocks` entry types its own card shape, which matches Chat SDK's CardElement except
    // for optional-property strictness. It keeps the adapter's Slack client out of the bundle.
    const card = toCard(defuseStrings(parsed.data), {
      components,
      limits: LIMITS,
    }) as SlackCardElement;
    // The adapter cuts blocks past its cap without an error, so ask for one more to detect it.
    const blocks = cardToSlackBlocks(card, { maxBlocks: MAX_BLOCKS + 1 });
    if (blocks.length > MAX_BLOCKS)
      return { ok: false, issues: [`the card needs more than ${MAX_BLOCKS} Slack blocks`] };
    return { ok: true, text: cardToSlackFallbackText(card), blocks };
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

// Card text must not ping a channel or a person, the same as every other Sym post. A link URL is
// not message text, and unsafeLinks already checked it.
function defuseStrings<T>(value: T): T {
  if (typeof value === "string") return defuse(value) as T;
  if (Array.isArray(value)) return value.map(defuseStrings) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, key === "url" ? item : defuseStrings(item)]),
    ) as T;
  }
  return value;
}
