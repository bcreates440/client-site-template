// Renders a page the way Jekyll does, from files held in memory, so the
// editor can show the real page the instant something changes instead of
// waiting a minute for GitHub Pages to rebuild.
//
// The libraries are passed in rather than imported, so the exact same code
// runs in the browser (editor) and in Node (ops/tools/editor-parity, which
// proves the output matches a real `jekyll build`). If parity ever fails
// after a template change, fix it here - never let the two drift.

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontMatter(text, YAML) {
  const m = text.match(FRONT_MATTER);
  if (!m) return { data: {}, body: text };
  return { data: YAML.parse(m[1]) ?? {}, body: m[2] };
}

// Jekyll's kramdown runs in GFM mode, which gives every heading an id.
function gfmId(text, seen) {
  let id = text.toLowerCase().replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
  if (seen.has(id)) {
    let n = 1;
    while (seen.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  seen.add(id);
  return id;
}

// kramdown's typographic symbols. Quotes stay plain: _config.yml sets
// smart_quotes to apos/quot.
function typography(s) {
  return s.replace(/---/g, "—").replace(/--/g, "–")
    .replace(/\.\.\./g, "…").replace(/<< /g, "« ").replace(/ >>/g, " »");
}

// ponytail: the entities people actually type. Anything else stays as written
// and the parity check will name it.
const ENTITIES = {
  nbsp: " ", mdash: "—", ndash: "–", hellip: "…", middot: "·",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•",
  copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
  frac12: "½", frac14: "¼", frac34: "¾", eacute: "é", rarr: "→",
  larr: "←", laquo: "«", raquo: "»", cent: "¢", pound: "£", euro: "€",
};
function entity(n) {
  if (n[0] === "#") return String.fromCodePoint(n[1].toLowerCase() === "x" ? parseInt(n.slice(2), 16) : +n.slice(1));
  return ENTITIES[n];
}

function makeMarkdown(Marked) {
  const md = new Marked({ gfm: true, breaks: false });
  let seen = new Set();
  md.use({
    hooks: { preprocess(src) { seen = new Set(); return src; } },
    // kramdown does not auto-link bare emails or web addresses; marked's GFM
    // mode does. Hand them back as plain text.
    tokenizer: {
      url(src) {
        const m = /^(?:[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:https?:\/\/|www\.)[^\s<]+)/.exec(src);
        if (m) return { type: "text", raw: m[0], text: m[0] };
      },
    },
    walkTokens(t) { if (t.type === "text" && !t.tokens) t.text = typography(t.text); },
    renderer: {
      // ponytail: inline code only; fenced code blocks (rouge-highlighted in
      // Jekyll) would need matching too if a client ever pastes one.
      codespan({ text }) {
        return `<code class="language-plaintext highlighter-rouge">${text}</code>`;
      },
      br() {
        return "<br />\n";
      },
      heading({ tokens, depth, text }) {
        return `<h${depth} id="${gfmId(text, seen)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  // kramdown leaves ' and " alone in text; marked escapes them. Undo that in
  // text only - inside attributes the escape is load-bearing.
  // kramdown also writes entities like &mdash; out as the character itself.
  const unescapeText = (html) =>
    html.replace(/<(br|hr|img|input)\b([^>]*?)\s*\/?>/gi, "<$1$2 />").replace(/>[^<]+</g, (t) => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (e, n) => entity(n) ?? e));
  return (s) => (s == null ? "" : unescapeText(md.parse(String(s))));
}

/**
 * files: Map of repo path -> text, for _config.yml, _layouts/*, _includes/**,
 *        _data/*.yml and _content/*.
 * Returns render(path, { editing, data }) -> full HTML of that page.
 *   data (optional) overrides the page's front matter, so the editor can
 *   render its unsaved in-memory copy.
 */
export function makeRenderer({ Liquid, Marked, YAML, files, now = new Date() }) {
  const markdownify = makeMarkdown(Marked);
  const read = (p) => {
    const t = files.get(p);
    if (t == null) throw new Error(`Missing file: ${p}`);
    return t;
  };
  const engine = new Liquid({
    jekyllInclude: true,
    dynamicPartials: false,
    relativeReference: false,
    partials: ["_includes"],
    extname: "",
    // Data-file dates like 2027-05-29 are plain dates in Jekyll. Formatting in
    // UTC keeps them from slipping a day in US time zones.
    timezoneOffset: 0,
    fs: {
      resolve: (root, file) => `${root}/${file}`,
      exists: async (p) => files.has(p),
      existsSync: (p) => files.has(p),
      readFile: async (p) => read(p),
      readFileSync: (p) => read(p),
      contains: () => true,
      sep: "/",
      dirname: (p) => p.slice(0, p.lastIndexOf("/")),
    },
  });
  engine.registerFilter("markdownify", markdownify);
  // Ruby Liquid divides whole numbers as whole numbers (1495 / 1000 = 1).
  engine.registerFilter("divided_by", (a, b) =>
    Number.isInteger(+a) && Number.isInteger(+b) ? Math.floor(a / b) : a / b);

  const config = YAML.parse(read("_config.yml")) ?? {};
  // Jekyll's URL filters, for sites served from a sub-folder (baseurl).
  const relativeUrl = (s) => {
    s = s == null ? "" : String(s);
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
    return (config.baseurl ?? "").replace(/\/$/, "") + (s.startsWith("/") ? s : `/${s}`);
  };
  engine.registerFilter("relative_url", relativeUrl);
  engine.registerFilter("absolute_url", (s) =>
    /^[a-z][a-z0-9+.-]*:/i.test(String(s ?? "")) ? s : (config.url ?? "").replace(/\/$/, "") + relativeUrl(s));
  const layoutDefault = config.defaults?.find((d) => d.scope?.type === "content")?.values?.layout;

  function siteVars(editing) {
    const data = {};
    for (const [p, text] of files) {
      const m = p.match(/^_data\/([^/]+)\.ya?ml$/);
      if (m) data[m[1]] = YAML.parse(text) ?? {};
    }
    return { ...config, data, time: now, editing: !!editing };
  }

  return async function render(path, { editing = false, data } = {}) {
    const { data: fm, body } = splitFrontMatter(read(path), YAML);
    const page = { ...(data ?? fm) };
    page.url ??= page.permalink;
    const site = siteVars(editing);
    let html = await engine.parseAndRender(body, { site, page });
    let layout = page.layout ?? layoutDefault;
    while (layout) {
      const { data: ld, body: lb } = splitFrontMatter(read(`_layouts/${layout}.html`), YAML);
      html = await engine.parseAndRender(lb, { site, page, layout: ld, content: html });
      layout = ld.layout;
    }
    return html;
  };
}
