// Works out which field of a page produced which words on screen, with no
// help from the templates.
//
// Every text value in the page gets invisible start/end markers (Unicode
// private-use characters), the page is rendered, and the markers in the
// output say exactly where each value landed. A second, unmarked render
// proves the markers changed nothing: if a value is also used for logic
// (a link keyword, a style name, a comparison), marking it would change the
// page, so that kind of field is found by halving the set until the culprit
// is isolated, and left unmarked. Those fields are still editable from the
// section's settings panel; they just aren't click-to-type.
//
// Each section also gets an invisible comment before it (<!--ed-block:N-->)
// through the 'raw' section type every site's layout already supports, so
// the editor knows where each section starts.

const MARK = /([-]+)|([-]+)/g;
const digits = (n) => [...n.toString(16)].map((c) => String.fromCharCode(0xe010 + parseInt(c, 16))).join("");
const undigits = (s) => parseInt([...s].map((c) => (c.charCodeAt(0) - 0xe010).toString(16)).join(""), 16);
export const strip = (s) => s.replace(MARK, "");
export const hasMark = (s) => /[]/.test(s);

// Reads markers out of one string: [{ id, start: true|false, index }]
export function readMarks(s) {
  const out = [];
  for (const m of s.matchAll(MARK)) out.push({ id: undigits(m[1] ?? m[2]), start: !!m[1], index: m.index, length: m[0].length });
  return out;
}

// "hero:buttons.*.label" - one name for the same field in every section of
// that type, so a field found unsafe once is skipped everywhere.
function pattern(path, data) {
  if (path[0] !== "blocks") return `page:${path.join(".")}`;
  const type = data.blocks[path[1]]?.type;
  return `${type}:${path.slice(2).map((p) => (typeof p === "number" ? "*" : p)).join(".")}`;
}

function* leaves(v, path = []) {
  if (typeof v === "string") { if (v !== "") yield path; return; }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) yield* leaves(v[i], [...path, i]); return; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "type") yield* leaves(x, [...path, k]);
}

const clone = (v) => structuredClone(v);
function setPath(obj, path, val) {
  let o = obj;
  for (const p of path.slice(0, -1)) o = o[p];
  o[path.at(-1)] = val;
}
const getPath = (obj, path) => path.reduce((o, p) => o?.[p], obj);

// The page data plus the section-start comments.
function withSentinels(data) {
  const d = clone(data);
  if (Array.isArray(d.blocks)) d.blocks = d.blocks.flatMap((b, i) => [{ type: "raw", html: `<!--ed-block:${i}-->` }, b]);
  return d;
}
// Field paths refer to the real blocks; with sentinels each block i sits at 2i+1.
const shift = (path) => (path[0] === "blocks" ? ["blocks", path[1] * 2 + 1, ...path.slice(2)] : path);

/**
 * render(data) -> html for one page.
 * unsafe: a Set of patterns already known to break when marked (shared
 *         across pages, grows as new ones are found).
 * Returns { html, fields } where html carries markers and fields[id] is the
 * path of that value in the page data (['blocks', 2, 'heading']).
 */
export async function markedRender(render, data, unsafe) {
  const base = withSentinels(data);
  const clean = await render(base);
  // Head fields (title...) aren't on screen, and Custom HTML sections are
  // never typed into: editing them in place could strip their code.
  const all = [...leaves(data)].filter((p) => p[0] === "blocks" && data.blocks[p[1]]?.type !== "raw");

  const build = (patterns) => {
    const d = clone(base), fields = [];
    for (const p of all) {
      if (!patterns.has(pattern(p, data))) continue;
      const id = fields.push(p) - 1;
      const n = digits(id);
      // Markers go inside any surrounding whitespace, so a multi-line value
      // doesn't grow an extra (empty) paragraph.
      // Same for a leading list bullet, heading or quote mark (markdown only
      // sees those at the very start of a line) and for **bold** or _italic_
      // marks at either end (markdown checks the character beside them).
      const [, lead, core, trail] = getPath(data, p)
        .match(/^(\s*(?:[-*+] |\d+[.)] |#{1,6} |> )?[*_~`]*)([\s\S]*?)([*_~`]*\s*)$/);
      setPath(d, shift(p), `${lead}${n}${core}${n}${trail}`);
    }
    return { d, fields };
  };
  const same = async (patterns) => strip(await render(build(patterns).d)) === clean;

  let todo = new Set(all.map((p) => pattern(p, data)).filter((x) => !unsafe.has(x)));
  if (!(await same(todo))) {
    // Halve until each pattern that changes the page is found.
    const bad = [];
    const hunt = async (list) => {
      if (await same(new Set(list))) return;
      if (list.length === 1) return bad.push(list[0]);
      const mid = list.length >> 1;
      await hunt(list.slice(0, mid));
      await hunt(list.slice(mid));
    };
    await hunt([...todo]);
    bad.forEach((b) => unsafe.add(b));
    todo = new Set([...todo].filter((x) => !unsafe.has(x)));
    // Only fails in combination? Then mark nothing on this page: the
    // settings panel still edits everything.
    if (!(await same(todo))) todo = new Set();
  }
  const { d, fields } = build(todo);
  return { html: await render(d), clean, fields };
}
