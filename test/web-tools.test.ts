import { webFetch } from "eve/tools/web_fetch";
import { webSearch } from "eve/tools/web_search";
import { afterEach, describe, expect, it, vi } from "vitest";
import fetchTool from "../agent/tools/web_fetch.ts";
import searchTool from "../agent/tools/web_search.ts";

const ctx = (principalId = "slack:T1:UOWNER") =>
  ({ session: { auth: { current: { principalId } } } }) as Parameters<typeof fetchTool.execute>[1];

afterEach(() => vi.unstubAllGlobals());

describe("web_fetch", () => {
  it("keeps Eve's schemas and reads a public page through its executor", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("<html><body><h1>Public guide</h1><p>Read this.</p></body></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(fetchTool.inputSchema).toBe(webFetch.inputSchema);
    expect(fetchTool.outputSchema).toBe(webFetch.outputSchema);
    const result = await fetchTool.execute({ url: "https://example.com/guide" }, ctx());
    expect(result).toMatchObject({
      content: "# Public guide\n\nRead this.",
      contentType: "text/html",
      truncated: false,
      url: "https://example.com/guide",
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://example.com/guide"),
      expect.objectContaining({ redirect: "manual", dispatcher: expect.anything() }),
    );
    expect(fetch.mock.calls[0]?.[1].headers).not.toHaveProperty("Authorization");
  });

  it("refuses worker callers before any fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await fetchTool.execute({ url: "https://example.com/guide" }, ctx("sym-worker")),
    ).toEqual({
      content: "Worker threads cannot call this tool.",
      contentType: "text/plain",
      truncated: false,
      url: "https://example.com/guide",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://localhost/",
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://100.64.0.1/",
    "https://169.254.169.254/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[::ffff:127.0.0.1]/",
  ])("keeps Eve's private-address refusal for %s", async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchTool.execute({ url }, ctx())).rejects.toThrow(
      "URL must not target localhost, private, link-local, or reserved IP addresses.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks a redirect destination before fetching it", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://10.0.0.1/private" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(fetchTool.execute({ url: "https://example.com/redirect" }, ctx())).rejects.toThrow(
      "URL must not target localhost, private, link-local, or reserved IP addresses.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses non-HTTPS URLs without fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchTool.execute({ url: "http://example.com/guide" }, ctx())).rejects.toThrow(
      "URL must start with https://",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("exports Eve's provider-managed search definition without a local executor", () => {
  expect(searchTool).toEqual(webSearch({ provider: "exa" }));
  expect(searchTool).not.toHaveProperty("execute");
});
