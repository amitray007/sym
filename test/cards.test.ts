import { describe, expect, it } from "vitest";
import { COMPONENT_GUIDE, renderCard } from "../lib/cards/card.ts";

const card = (children: string[], elements: Record<string, unknown>) => ({
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Deploys this week" }, children },
    ...elements,
  },
});
const pie = {
  type: "Chart",
  props: { title: "Share", chart: { type: "pie", segments: [{ label: "api", value: 3 }] } },
  children: [],
};

describe("generative cards", () => {
  it("renders a table, a chart, and a link as native Slack blocks with fallback text", () => {
    const result = renderCard(
      card(["table", "chart", "links"], {
        table: {
          type: "Table",
          props: { headers: ["Service", "Deploys"], rows: [["api", 4]] },
          children: [],
        },
        chart: {
          type: "Chart",
          props: {
            title: "Deploys",
            chart: {
              type: "bar",
              categories: ["api", "web"],
              series: [{ name: "deploys", values: [4, 2] }],
            },
          },
          children: [],
        },
        links: { type: "Actions", props: {}, children: ["open"] },
        open: {
          type: "LinkButton",
          props: { label: "Open", url: "https://example.com" },
          children: [],
        },
      }),
    );
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(result.blocks.map((block) => block.type)).toEqual([
      "header",
      "data_table",
      "data_visualization",
      "actions",
    ]);
    expect(result.text).toContain("Deploys this week");
    expect(result.text).toContain("api");
  });

  it("returns readable issues for a bad spec so the model can fix it", () => {
    const result = renderCard(
      card(["chart"], { chart: { type: "Chart", props: { title: "x" }, children: [] } }),
    );
    expect(result).toMatchObject({ ok: false, issues: [expect.stringContaining("chart")] });
  });

  it("refuses components outside Sym's catalog", () => {
    const result = renderCard(
      card(["go"], { go: { type: "Button", props: { id: "go", label: "Go" }, children: [] } }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a link that is not http or https", () => {
    const result = renderCard(
      card(["links"], {
        links: { type: "Actions", props: {}, children: ["open"] },
        open: {
          type: "LinkButton",
          props: { label: "Run", url: "javascript:alert(1)" },
          children: [],
        },
      }),
    );
    expect(result).toEqual({
      ok: false,
      issues: ["open.props.url: use a full http or https link"],
    });
  });

  it("keeps Slack's two-chart limit", () => {
    expect(renderCard(card(["a", "b"], { a: pie, b: pie })).ok).toBe(true);
    expect(renderCard(card(["a", "b", "c"], { a: pie, b: pie, c: pie })).ok).toBe(false);
  });

  it("defuses channel and person pings in card text", () => {
    const result = renderCard(
      card(["note"], {
        note: { type: "Text", props: { content: "Ping <!channel> and <@U1> @here" }, children: [] },
      }),
    );
    if (!result.ok) throw new Error(result.issues.join("; "));
    const posted = JSON.stringify(result.blocks) + result.text;
    expect(posted).not.toMatch(/<!|<@|@here/);
  });

  it("defuses nested pings that one pass would rebuild", () => {
    const result = renderCard(
      card(["note"], {
        note: { type: "Text", props: { content: "Ping <<!channel>> and <<@U1>>" }, children: [] },
      }),
    );
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(JSON.stringify(result.blocks) + result.text).not.toMatch(/<!|<@/);
  });

  it("refuses expressions, repeat, and visible, which would render nothing or skip defusing", () => {
    const text = (content: unknown) => ({ type: "Text", props: { content }, children: [] });
    const refused = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: json-render's own template syntax
      card(["note"], { note: text({ $template: "<${/x}!channel> hi" }) }),
      card(["note"], { note: text({ $cond: { $state: "/n" }, $then: "a", $else: "<@U1>" }) }),
      card(["note"], { note: { ...text("Row"), repeat: { statePath: "/rows" } } }),
      card(["note"], { note: { ...text("Hidden"), visible: false } }),
    ];
    for (const spec of refused) expect(renderCard(spec).ok).toBe(false);
  });

  it("refuses a card that needs more than Slack's 50 blocks instead of cutting it", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const notes = Object.fromEntries(
      ids.map((id) => [id, { type: "Text", props: { content: id }, children: [] }]),
    );
    expect(renderCard(card(ids.slice(0, 49), notes)).ok).toBe(true);
    expect(renderCard(card(ids, notes))).toEqual({
      ok: false,
      issues: ["the card needs more than 50 Slack blocks"],
    });
  });

  it("keeps Slack's one-table limit", () => {
    const table = {
      type: "Table",
      props: { headers: ["Service"], rows: [["api"]] },
      children: [],
    };
    expect(renderCard(card(["a"], { a: table })).ok).toBe(true);
    expect(renderCard(card(["a", "b"], { a: table, b: table })).ok).toBe(false);
  });

  it("leaves a link URL as given", () => {
    const url = "https://example.com/search?q=@here";
    const result = renderCard(
      card(["links"], {
        links: { type: "Actions", props: {}, children: ["open"] },
        open: { type: "LinkButton", props: { label: "Open", url }, children: [] },
      }),
    );
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(JSON.stringify(result.blocks)).toContain(url);
  });

  it("drops a card image", () => {
    const result = renderCard({
      root: "card",
      elements: {
        card: {
          type: "Card",
          props: { title: "T", imageUrl: "https://example.com/a.png" },
          children: [],
        },
      },
    });
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(JSON.stringify(result.blocks)).not.toContain("example.com/a.png");
  });

  it("describes each catalog component for the tool", () => {
    for (const name of ["Card", "Text", "Fields", "Field", "Table", "Chart", "LinkButton"]) {
      expect(COMPONENT_GUIDE).toContain(`- ${name}: {`);
    }
    expect(COMPONENT_GUIDE).not.toContain("- Button:");
  });

  const text = (content: string) => ({ type: "Text", props: { content }, children: [] });
  const line = (categories: string[], title = "Latency") => ({
    type: "Chart",
    props: {
      title,
      chart: {
        type: "line",
        categories,
        series: [{ name: "p95", values: categories.map(() => 1) }],
      },
    },
    children: [],
  });

  it("defuses text in an element whose id is url", () => {
    const result = renderCard(card(["url"], { url: text("hi <!channel> <@U1>") }));
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(JSON.stringify(result.blocks) + result.text).not.toMatch(/<!|<@/);
  });

  it("keeps element ids as written, so a mention in an id still renders", () => {
    const result = renderCard(card(["here@here"], { "here@here": text("ok") }));
    expect(result.ok).toBe(true);
  });

  it("refuses a chart Slack can't draw instead of posting it as text", () => {
    const days = Array.from({ length: 30 }, (_, i) => `d${i + 1}`);
    expect(renderCard(card(["c"], { c: line(days) }))).toMatchObject({
      ok: false,
      issues: [expect.stringContaining("at most 20 categories")],
    });
    expect(renderCard(card(["c"], { c: line(["a"], "x".repeat(51)) })).ok).toBe(false);
    expect(renderCard(card(["c"], { c: line(["mon", "mon"]) }))).toMatchObject({
      ok: false,
      issues: [expect.stringContaining("could not become a Slack chart")],
    });
  });

  it("refuses more than ten fields instead of dropping the rest", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `f${i}`);
    const fields = Object.fromEntries(
      ids.map((id) => [id, { type: "Field", props: { label: id, value: 1 }, children: [] }]),
    );
    const spec = card(["kpis"], { kpis: { type: "Fields", props: {}, children: ids }, ...fields });
    expect(renderCard(spec).ok).toBe(false);
  });

  it("refuses text Slack would cut", () => {
    expect(renderCard(card(["t"], { t: text("x".repeat(3001)) }))).toMatchObject({
      ok: false,
      issues: ["t.props.content: at most 3000 characters"],
    });
  });

  it("refuses two link buttons with one link and gives each button its own id", () => {
    const button = (url: string) => ({
      type: "LinkButton",
      props: { label: "Open", url },
      children: [],
    });
    const links = (a: string, b: string) =>
      card(["row"], {
        row: { type: "Actions", props: {}, children: ["a", "b"] },
        a: button(a),
        b: button(b),
      });
    expect(renderCard(links("https://x.com", "https://x.com")).ok).toBe(false);
    const result = renderCard(links("https://x.com/a", "https://x.com/b"));
    if (!result.ok) throw new Error(result.issues.join("; "));
    const ids = JSON.stringify(result.blocks).match(/sym_card_link_\d/g);
    expect(ids).toEqual(["sym_card_link_0", "sym_card_link_1"]);
  });

  it("turns Markdown links in text into Slack links", () => {
    const result = renderCard(card(["t"], { t: text("See [the board](https://x.com/b) now") }));
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(JSON.stringify(result.blocks)).toContain("<https://x.com/b|the board>");
  });
});
