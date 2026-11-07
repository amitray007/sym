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
});
