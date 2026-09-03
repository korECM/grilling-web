// raw html, svg 블록 정제기. 허용 목록 방식이다.
// 목록에 없는 태그는 껍데기만 벗기고 내용은 남긴다. 위험한 태그는 내용까지 지운다.
// 속성은 요소별 허용 목록과 전역 목록에 있는 것만 남기고, URL 속성은 스킴을 검사한다.
// 브라우저에서는 window.grillSanitize, 테스트에서는 module.exports.sanitize 로 쓴다.
(function (root) {
  const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "form", "input", "button", "textarea", "select", "option", "template", "noscript", "foreignobject", "animate", "animatemotion", "animatetransform", "set"]);
  const HTML_TAGS = new Set(["p", "br", "div", "span", "ul", "ol", "li", "strong", "em", "b", "i", "u", "s", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "img", "figure", "figcaption", "blockquote", "hr", "small", "sup", "sub", "mark", "kbd", "dl", "dt", "dd", "caption"]);
  const SVG_TAGS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textpath", "defs", "use", "marker", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "title", "desc", "image"]);
  const GLOBAL_ATTRS = new Set(["class", "id", "title", "lang", "dir", "role"]);
  const ATTRS = {
    a: ["href", "target"],
    img: ["src", "alt", "width", "height", "loading"],
    td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"],
    ol: ["start", "type"],
  };
  const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "data", "poster"]);
  const SAFE_URL = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|[a-z0-9_-][^:]*$)/i;
  const SAFE_IMG = /^(https?:|data:image\/(png|jpeg|gif|webp|svg\+xml);|\/|\.\/|\.\.\/|[a-z0-9_-][^:]*$)/i;

  function urlOk(tag, value) {
    const v = value.replace(/[\x00-\x20]/g, ""); // 제어 문자와 공백으로 스킴을 숨기는 수법 방지
    if (tag === "use") return v.startsWith("#");
    if (tag === "img" || tag === "image") return SAFE_IMG.test(v);
    return SAFE_URL.test(v);
  }
  // style은 통째로 뺀다. CSS 이스케이프(u\72l)나 position:fixed 오버레이처럼 걸러내기 어려운 길이 많다.
  // 폼이 필요로 하는 스타일은 전부 클래스로 건다.
  function attrOk(tag, isSvg, name, value) {
    if (name.startsWith("on") || name === "srcdoc" || name === "style") return false;
    if (URL_ATTRS.has(name)) return urlOk(tag, value);
    if (GLOBAL_ATTRS.has(name) || name.startsWith("aria-") || name.startsWith("data-")) return true;
    // svg 프레젠테이션 속성은 CSS 값이라 이스케이프(u\72l)로 url(을 숨길 수 있다. 역슬래시가 있으면 통째로 버린다.
    if (isSvg) return !value.includes("\\") && !/url\s*\(\s*(?!['"]?#)/i.test(value); // fill="url(#local)"만 허용
    return (ATTRS[tag] ?? []).includes(name);
  }

  function sanitize(markup) {
    const root = new DOMParser().parseFromString(`<div>${markup ?? ""}</div>`, "text/html").body.firstElementChild;
    const walk = (el, inSvg) => {
      let child = el.firstElementChild;
      while (child) {
        const next = child.nextElementSibling;
        const tag = child.localName.toLowerCase();
        if (DROP.has(tag)) { el.removeChild(child); child = next; continue; }
        const isSvg = inSvg || tag === "svg";
        const allowed = isSvg ? SVG_TAGS.has(tag) : HTML_TAGS.has(tag);
        if (!allowed) {
          // 껍데기만 벗긴다. 안에 있던 요소가 이 자리로 올라오므로 그 첫 요소부터 다시 검사한다.
          const first = child.firstElementChild;
          while (child.firstChild) el.insertBefore(child.firstChild, child);
          el.removeChild(child);
          child = first ?? next;
          continue;
        }
        for (const attr of Array.from(child.attributes)) {
          if (!attrOk(tag, isSvg, attr.name.toLowerCase(), attr.value)) child.removeAttribute(attr.name);
        }
        if (tag === "a") child.setAttribute("rel", "noopener noreferrer");
        walk(child, isSvg);
        child = next;
      }
    };
    walk(root, false);
    return root.innerHTML;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { sanitize };
  root.grillSanitize = sanitize;
})(typeof globalThis !== "undefined" ? globalThis : this);
