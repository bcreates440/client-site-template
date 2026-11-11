// Turns the marked-up preview into something you can click and type into.
//
// After a marked render (fields.js) is drawn in the preview, mapDom() finds
// every marker, ties the element that shows each value to that value's path
// in the page data, removes every marker, and tags each element with the
// section it belongs to.

// Same version stamp as the file that loaded this one (see editor.js).
const { readMarks, strip, hasMark } = await import(`./fields.js${new URL(import.meta.url).search}`);

const norm = (s) => strip(s).replace(/\s+/g, " ").trim();

/**
 * doc:    the preview's document (already showing the marked HTML)
 * fields: id -> path, from markedRender()
 * Returns { spots: Map(id -> { el, exact }) } and sets on elements:
 *   data-ed-f="id"      this element shows exactly that value: click to type
 *   data-ed-near="id"   value is in here among other things: click opens settings
 *   data-ed-block="n"   part of section n
 */
export function mapDom(doc, fields) {
  const body = doc.body;
  const starts = new Map(), ends = new Map();

  // 1. Where each marker sits in the text.
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (hasMark(n.data)) texts.push(n);
  for (const node of texts) {
    for (const m of readMarks(node.data)) (m.start ? starts : ends).set(m.id, { node, index: m.index, length: m.length });
  }

  // 2. Values inside attributes (alt text, labels): just clean them.
  for (const el of body.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (hasMark(a.value)) el.setAttribute(a.name, strip(a.value));
  }

  // 3. Decide which element shows each value. Done before stripping, while
  //    the marker offsets are still right; the latest markers first, so a
  //    split never moves a marker we still need.
  const spots = new Map();
  // (Values never nest inside each other, so last-to-first by where each one
  // starts is enough.)
  const order = new Map(texts.map((n, i) => [n, i]));
  const ids = [...starts.keys()].filter((id) => ends.has(id)).sort((a, b) => {
    const x = starts.get(a), y = starts.get(b);
    return order.get(y.node) - order.get(x.node) || y.index - x.index;
  });
  for (const id of ids) {
    const s = starts.get(id), e = ends.get(id);
    const range = doc.createRange();
    range.setStart(s.node, s.index + s.length);
    range.setEnd(e.node, e.index);
    const value = norm(range.toString());
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    if (norm(el.textContent) === value && !el.hasAttribute("data-ed-f")) {
      el.setAttribute("data-ed-f", id);
      spots.set(id, { el, exact: true });
    } else if (s.node === e.node) {
      // Shares its element with other words (e.g. "Day 1 · Thursday"):
      // give it its own span so it can still be typed into.
      const span = doc.createElement("span");
      span.setAttribute("data-ed-f", id);
      range.surroundContents(span);
      spots.set(id, { el: span, exact: true });
    } else {
      if (!el.hasAttribute("data-ed-near")) el.setAttribute("data-ed-near", id);
      spots.set(id, { el, exact: false });
    }
  }

  // 4. Remove every marker.
  const all = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = all.nextNode(); n; n = all.nextNode()) if (hasMark(n.data)) n.data = strip(n.data);

  // 5. Sections: everything after <!--ed-block:N--> up to the next one.
  const comments = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  for (let c = comments.nextNode(); c; c = comments.nextNode()) {
    const m = c.data.match(/^ed-block:(\d+)$/);
    if (!m) continue;
    for (let sib = c.nextSibling; sib; sib = sib.nextSibling) {
      if (sib.nodeType === 8 && /^ed-block:/.test(sib.data)) break;
      if (sib.nodeType === 1) sib.setAttribute("data-ed-block", m[1]);
    }
  }

  // Answers inside closed <details> (FAQs) need to be visible to edit.
  for (const d of body.querySelectorAll("details")) d.open = true;
  return { spots };
}

// ------------------------------------------------------------ text <-> value
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export const escapeText = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);
export function htmlToText(doc, html) {
  const t = doc.createElement("template");
  t.innerHTML = html;
  return t.content.textContent;
}

// The only markup a client can produce by typing in place.
const KEEP = new Set(["EM", "STRONG", "B", "I", "BR", "A", "SMALL"]);
export function cleanHtml(el) {
  let out = "";
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += escapeText(n.data);
    else if (n.nodeType === 1) {
      const inner = cleanHtml(n);
      if (!KEEP.has(n.tagName)) { out += inner; continue; }
      const tag = n.tagName.toLowerCase();
      if (tag === "br") { out += "<br>"; continue; }
      if (tag === "a") {
        const href = n.getAttribute("href") || "";
        out += /^(https?:|mailto:|tel:|\/|#)/i.test(href) ? `<a href="${href.replace(/"/g, "&quot;")}">${inner}</a>` : inner;
        continue;
      }
      out += `<${tag}>${inner}</${tag}>`;
    }
  }
  return out;
}
