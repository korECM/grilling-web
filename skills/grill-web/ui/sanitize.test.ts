// sanitize.js 허용 목록 테스트. DOMParser는 happy-dom으로 채운다.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRequire } from "node:module";

const win = new Window();
(globalThis as any).DOMParser = win.DOMParser;
const { sanitize } = createRequire(import.meta.url)("./sanitize.js") as { sanitize: (m: string) => string };

describe("html", () => {
  test("keeps ordinary markup", () => {
    expect(sanitize("<p>hi <strong>there</strong></p><ul><li>a</li></ul>")).toBe("<p>hi <strong>there</strong></p><ul><li>a</li></ul>");
  });
  test("drops scripts, styles, frames and forms with their content", () => {
    for (const bad of ["<script>alert(1)</script>", "<style>*{}</style>", "<iframe src=x></iframe>", "<form><input></form>", "<object data=x></object>", "<template><p>x</p></template>"]) {
      expect(sanitize(`<p>a</p>${bad}<p>b</p>`)).toBe("<p>a</p><p>b</p>");
    }
  });
  test("unwraps unknown tags but keeps their text", () => {
    expect(sanitize("<section><custom-x>text</custom-x></section>")).toBe("text");
    expect(sanitize("<video><p>fallback</p></video>")).toBe("<p>fallback</p>");
  });
  test("still sanitizes what an unwrapped tag was hiding", () => {
    expect(sanitize('<section><p onclick="x()">t</p><script>y()</script></section><p>z</p>')).toBe("<p>t</p><p>z</p>");
    expect(sanitize('<main><article><a href="javascript:1">l</a></article></main>')).toBe('<a rel="noopener noreferrer">l</a>');
  });
  test("strips event handlers and srcdoc", () => {
    expect(sanitize('<p onclick="x()" onmouseover="y()">t</p>')).toBe("<p>t</p>");
    expect(sanitize('<div srcdoc="<script>"></div>')).toBe("<div></div>");
  });
  test("strips javascript: and data:text/html links, keeps http and anchors", () => {
    expect(sanitize('<a href="javascript:alert(1)">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(sanitize('<a href="JAVA\tSCRIPT:alert(1)">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(sanitize('<a href="data:text/html,x">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(sanitize('<a href="https://example.com" target="_blank">x</a>')).toBe('<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>');
    expect(sanitize('<a href="#top">x</a>')).toBe('<a href="#top" rel="noopener noreferrer">x</a>');
  });
  test("img keeps http and data:image, drops the rest", () => {
    expect(sanitize('<img src="https://x/y.png" alt="a" onerror="z()">')).toBe('<img src="https://x/y.png" alt="a">');
    expect(sanitize('<img src="data:image/png;base64,AAAA">')).toBe('<img src="data:image/png;base64,AAAA">');
    expect(sanitize('<img src="data:text/html,x">')).toBe("<img>");
  });
  test("removes attributes that are not on the allowlist", () => {
    expect(sanitize('<p class="a" id="b" title="c" data-k="v" aria-label="l" contenteditable="true" tabindex="1">t</p>')).toBe('<p class="a" id="b" title="c" data-k="v" aria-label="l">t</p>');
    expect(sanitize('<td colspan="2" rowspan="3" bgcolor="red">t</td>')).toBe('<td colspan="2" rowspan="3">t</td>');
  });
  test("style survives unless it pulls in urls or expressions", () => {
    expect(sanitize('<p style="color:red">t</p>')).toBe('<p style="color:red">t</p>');
    expect(sanitize('<p style="background:url(http://x)">t</p>')).toBe("<p>t</p>");
    expect(sanitize('<p style="width:expression(alert(1))">t</p>')).toBe("<p>t</p>");
  });
  test("handles empty and null input", () => {
    expect(sanitize("")).toBe("");
    expect(sanitize(null as any)).toBe("");
  });
});

describe("svg", () => {
  test("keeps shapes, text and presentation attributes", () => {
    const svg = '<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#eee" stroke="#000"></rect><text x="5" y="5" font-size="3">ok</text></svg>';
    expect(sanitize(svg)).toBe(svg);
  });
  test("drops script, foreignObject and animation elements inside svg", () => {
    expect(sanitize('<svg><script>x()</script><foreignObject><div>h</div></foreignObject><animate attributeName="x"></animate><circle r="1"></circle></svg>')).toBe('<svg><circle r="1"></circle></svg>');
  });
  test("strips handlers and non-local use hrefs", () => {
    expect(sanitize('<svg><use href="#a" onload="x()"></use><use href="https://evil/x.svg#a"></use></svg>')).toBe('<svg><use href="#a"></use><use></use></svg>');
  });
  test("image inside svg follows the image rules", () => {
    expect(sanitize('<svg><image href="https://x/y.png"></image><image href="javascript:x"></image></svg>')).toBe('<svg><image href="https://x/y.png"></image><image></image></svg>');
  });
});
