import { renderToStaticMarkup } from "react-dom/server";
import { withNames } from "@/components/studio/ai-names";

// Spans only hold the plain parts, so they are dropped to compare what is drawn.
const html = (text: string) =>
  renderToStaticMarkup(<p>{withNames(text)}</p>).replace(/<\/?span>/g, "");

describe("withNames", () => {
  it("writes backticked names as code", () => {
    expect(html("Add `stock` to `books`.")).toBe(
      '<p>Add <code class="mono">stock</code> to <code class="mono">books</code>.</p>'
    );
  });

  it("draws **words** in bold, also around a name", () => {
    expect(html("**Breaking:** `qty` check")).toBe(
      '<p><strong>Breaking:</strong> <code class="mono">qty</code> check</p>'
    );
  });

  it("leaves stars inside a name and lone stars alone", () => {
    expect(html("`a**b**c` costs 2 * 3 ** 4")).toContain('<code class="mono">a**b**c</code>');
    expect(html("2 * 3 ** 4")).not.toContain("<strong>");
  });
});
