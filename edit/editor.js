// The click-to-edit website editor.
//
// Reads the site's own files from GitHub, draws the real page with the same
// templates Jekyll uses (render.js), finds which words came from which value
// (fields.js, dom.js), and lets the client click any of them to type. Every
// change is kept on this computer until it's published.
//
// Settings come from ../admin/config.yml (the same file the backup editor
// at /admin/ uses): which repo and branch, the sign-in worker, and every
// section type and field.

import YAML from "https://unpkg.com/yaml@2.9.1/browser/index.js";
import { Liquid } from "https://cdn.jsdelivr.net/npm/liquidjs@10.30.0/dist/liquid.browser.mjs";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@18.1.2/lib/marked.esm.js";
// The editor's own files are loaded with this file's version stamp
// (index.html adds ?v=<build time>), so after an update a browser can never
// mix an old copy of one file with a new copy of another.
const V = new URL(import.meta.url).search;
const { makeRenderer, splitFrontMatter } = await import(`./render.js${V}`);
const { markedRender } = await import(`./fields.js${V}`);
const { mapDom, escapeText, htmlToText, cleanHtml } = await import(`./dom.js${V}`);
const { drawForm, fieldAt, blockType } = await import(`./panel.js${V}`);

const $ = (id) => document.getElementById(id);
const SITE_ROOT = new URL("../", location.href).href;
const TOKEN_KEY = "site-editor.token";
// Page settings a client should never need to touch (they break links).
const HIDDEN_PAGE_FIELDS = new Set(["slug", "permalink", "layout", "blocks"]);

const state = {
  config: null,      // admin/config.yml, parsed
  pageFields: [],    // the pages collection's field list
  repo: "",
  branch: "",
  base: "",          // commit the files were loaded from
  token: "",
  files: new Map(),     // repo path -> current text (what the renderer reads)
  original: new Map(),  // repo path -> text as loaded
  docs: new Map(),      // _content path -> { doc, body } (parsed front matter)
  unsafe: new Set(),    // field kinds that can't be marked (see fields.js)
  render: null,
  pages: [],
  current: "",
  fields: [],           // marker id -> path, for the page on screen
  selected: null,       // section index shown in the panel, or "page"
  undo: [],
  redo: [],
};

// ---------------------------------------------------------------- status ---
let statusTimer;
function say(msg, { sticky = false } = {}) {
  $("status").textContent = msg;
  clearTimeout(statusTimer);
  if (!sticky && msg) statusTimer = setTimeout(() => ($("status").textContent = ""), 4000);
}
function show(screen) {
  for (const id of ["screen-signin", "screen-loading", "workspace"]) $(id).hidden = id !== screen;
  $("bar").hidden = screen !== "workspace";
}
function loading(text) {
  $("loading-text").textContent = text;
  show("screen-loading");
}
function fail(text) {
  loading(text);
  document.querySelector("#screen-loading .spinner").hidden = true;
}

// --------------------------------------------------------------- sign-in ---
// Signed in to the backup editor already? Use that: one sign-in for both.
function storedToken() {
  try {
    const sveltia = JSON.parse(localStorage.getItem("sveltia-cms.user") || "null");
    if (sveltia?.backendName === "github" && sveltia.token) return sveltia.token;
  } catch {}
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

// Same popup handshake Sveltia/Decap use, so each client's existing sign-in
// worker works unchanged: the popup says "authorizing", we echo it back, and
// it answers with the token.
function signInPopup() {
  const { base_url, auth_endpoint = "auth" } = state.config.backend;
  const url = new URL(auth_endpoint, base_url.replace(/\/?$/, "/"));
  url.searchParams.set("provider", "github");
  url.searchParams.set("site_id", location.hostname);
  url.searchParams.set("scope", "repo");
  const popup = window.open(url, "site-editor-signin", "width=600,height=760");
  if (!popup) return Promise.reject(new Error("Your browser blocked the sign-in window. Allow pop-ups for this site and try again."));
  const workerOrigin = url.origin;
  return new Promise((resolve, reject) => {
    function onMessage(e) {
      if (e.origin !== workerOrigin || typeof e.data !== "string") return;
      if (e.data === "authorizing:github") return popup.postMessage(e.data, e.origin);
      const m = e.data.match(/^authorization:github:(success|error):(.*)$/s);
      if (!m) return;
      window.removeEventListener("message", onMessage);
      let body = {};
      try { body = JSON.parse(m[2]); } catch {}
      if (m[1] === "success" && body.token) resolve(body.token);
      else reject(new Error(body.error || "Sign-in didn't finish. Please try again."));
    }
    window.addEventListener("message", onMessage);
  });
}

function askToSignIn(message = "") {
  show("screen-signin");
  $("signin-error").textContent = message;
  $("signin").onclick = async () => {
    $("signin-error").textContent = "";
    try {
      state.token = await signInPopup();
      try { localStorage.setItem(TOKEN_KEY, state.token); } catch {}
      await open();
    } catch (err) {
      $("signin-error").textContent = err.message;
    }
  };
}

// ---------------------------------------------------------------- GitHub ---
class SignedOut extends Error {}
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...opts.headers,
    },
  });
  if (res.status === 401) throw new SignedOut();
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${path}`);
  return res.json();
}

const fromBase64 = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

// Everything the renderer and editor read. Pictures aren't downloaded: the
// preview loads them from the live site.
const WANTED = /^(_layouts|_includes|_data|_content)\/.+\.(html|ya?ml)$|^_config\.yml$|^admin\/config\.yml$/;

async function loadFiles() {
  const branch = await gh(`/repos/${state.repo}/branches/${encodeURIComponent(state.branch)}`);
  state.base = branch.commit.sha;
  const tree = await gh(`/repos/${state.repo}/git/trees/${branch.commit.commit.tree.sha}?recursive=1`);
  const blobs = tree.tree.filter((t) => t.type === "blob" && WANTED.test(t.path));
  let done = 0;
  await Promise.all(blobs.map(async (b) => {
    const blob = await gh(`/repos/${state.repo}/git/blobs/${b.sha}`);
    const text = fromBase64(blob.content).replace(/\r\n/g, "\n");
    state.files.set(b.path, text);
    state.original.set(b.path, text);
    loading(`Loading your website… ${++done} of ${blobs.length}`);
  }));
}

// ------------------------------------------------------------- page data ---
const FM = /^---\n([\s\S]*?\n)?---\n?([\s\S]*)$/;
function docFor(path) {
  if (!state.docs.has(path)) {
    const m = state.files.get(path).match(FM);
    state.docs.set(path, { doc: YAML.parseDocument(m?.[1] ?? ""), body: m?.[2] ?? "" });
  }
  return state.docs.get(path);
}
const pageData = (path = state.current) => docFor(path).doc.toJS() ?? {};
const valueAt = (path) => path.reduce((o, p) => o?.[p], pageData());

// Writes the page's file back from its YAML document. Comments, key order
// and every field the editor doesn't know about are kept, and the result is
// read back to prove it says what we meant before anything is stored.
function writePage(path) {
  const { doc, body } = docFor(path);
  const text = `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`;
  const reread = YAML.parse(text.match(FM)[1]);
  if (JSON.stringify(reread) !== JSON.stringify(doc.toJS())) throw new Error("A change didn't save cleanly, so it was not kept.");
  state.files.set(path, text);
}

// ------------------------------------------------------ undo and drafts ---
let lastChange = { key: "", at: 0 };
function remember(file, key) {
  // Typing in one box counts as one change until you pause or move on.
  const now = Date.now();
  if (key && key === lastChange.key && now - lastChange.at < 1500) { lastChange.at = now; return; }
  lastChange = { key, at: now };
  state.undo.push({ file, text: state.files.get(file) });
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
}
function restore(from, to) {
  const step = from.pop();
  if (!step) return;
  to.push({ file: step.file, text: state.files.get(step.file) });
  state.files.set(step.file, step.text);
  state.docs.delete(step.file);
  lastChange = { key: "", at: 0 };
  changed({ redrawPanel: true });
  if (step.file !== state.current) goTo(step.file);
}

const draftKey = () => `site-editor.draft:${state.repo}@${state.branch}`;
function changedFiles() {
  return [...state.files].filter(([p, t]) => state.original.get(p) !== t);
}
function saveDraft() {
  const files = Object.fromEntries(changedFiles());
  try {
    if (Object.keys(files).length) localStorage.setItem(draftKey(), JSON.stringify({ base: state.base, saved: Date.now(), files }));
    else localStorage.removeItem(draftKey());
  } catch {
    say("Couldn't save a copy on this computer - publish soon so nothing is lost.", { sticky: true });
  }
}
function offerDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch {}
  if (!draft?.files || !Object.keys(draft.files).length) return;
  const when = new Date(draft.saved).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  $("notice-text").textContent = `You have changes from ${when} that haven't been published yet.`;
  $("notice").hidden = false;
  $("notice-keep").onclick = () => {
    for (const [p, t] of Object.entries(draft.files)) { state.files.set(p, t); state.docs.delete(p); }
    $("notice").hidden = true;
    changed({ redrawPanel: true });
    say("Your earlier changes are back.");
  };
  $("notice-discard").onclick = () => {
    try { localStorage.removeItem(draftKey()); } catch {}
    $("notice").hidden = true;
  };
}

// After any change: save a copy, update the buttons, redraw.
let redrawTimer;
function changed({ redrawPanel = false } = {}) {
  saveDraft();
  const n = changedFiles().length;
  $("saved").textContent = n ? "Changes saved on this computer" : "";
  $("undo").disabled = !state.undo.length;
  $("redo").disabled = !state.redo.length;
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    draw();
    if (redrawPanel) drawPanel();
  }, 250);
}

// ------------------------------------------------------------ changes ---
function setValue(path, value) {
  remember(state.current, JSON.stringify(path));
  docFor(state.current).doc.setIn(path, value);
  try { writePage(state.current); } catch (err) { return say(err.message, { sticky: true }); }
  changed();
}

function listOp(path, op, i, item) {
  remember(state.current, "");
  const { doc } = docFor(state.current);
  const seq = doc.getIn(path, true);
  if (op === "add") {
    if (seq?.items) seq.items.push(doc.createNode(item));
    else doc.setIn(path, [item]);
  } else if (op === "remove") {
    seq.items.splice(i, 1);
  } else if (op === "copy") {
    seq.items.splice(i + 1, 0, doc.createNode(seq.items[i].toJSON()));
  } else {
    const j = op === "up" ? i - 1 : i + 1;
    [seq.items[i], seq.items[j]] = [seq.items[j], seq.items[i]];
  }
  try { writePage(state.current); } catch (err) { return say(err.message, { sticky: true }); }
  changed({ redrawPanel: true });
}

// ---------------------------------------------------------------- panel ---
function drawPanel(focusPath) {
  const panel = $("panel");
  if (state.selected == null) { panel.hidden = true; return; }
  const data = pageData();
  let fields, value, path, title;
  if (state.selected === "page") {
    fields = state.pageFields.filter((f) => !HIDDEN_PAGE_FIELDS.has(f.name));
    value = data; path = []; title = "Page settings";
  } else {
    const block = data.blocks?.[state.selected];
    const type = block && blockType(state.pageFields, block.type);
    if (!type) { state.selected = null; panel.hidden = true; return; }
    fields = type.fields; value = block; path = ["blocks", state.selected]; title = type.label;
    if (block.type === "raw") {
      $("panel-title").textContent = title;
      panel.hidden = false;
      $("panel-form").replaceChildren(Object.assign(document.createElement("p"), {
        className: "locked",
        textContent: "This section was built specially, so it can't be changed here. You can still move or remove it. Ask Blake if it needs changing.",
      }));
      return;
    }
  }
  $("panel-title").textContent = title;
  panel.hidden = false;
  drawForm($("panel-form"), fields, value, path, { set: setValue, list: listOp, focusPath });
  if (focusPath) {
    const el = $("panel-form").querySelector(`[data-path='${JSON.stringify(focusPath)}']`);
    if (el) { el.scrollIntoView({ block: "center" }); el.focus({ preventScroll: true }); }
  }
}

function select(block, focusPath) {
  state.selected = block;
  highlight();
  drawPanel(focusPath);
}

function highlight() {
  const doc = $("frame").contentDocument;
  if (!doc) return;
  doc.querySelectorAll(".ed-selected").forEach((el) => el.classList.remove("ed-selected"));
  if (typeof state.selected === "number") doc.querySelectorAll(`[data-ed-block="${state.selected}"]`).forEach((el) => el.classList.add("ed-selected"));
}

// --------------------------------------------------------------- sections ---
const blockCount = () => pageData().blocks?.length ?? 0;
const typeLabel = (n) => blockType(state.pageFields, pageData().blocks?.[n]?.type)?.label ?? "Section";

function sectionOp(op, n) {
  const count = blockCount();
  if (op === "up" && n === 0) return;
  if (op === "down" && n === count - 1) return;
  const label = typeLabel(n);
  if (op === "up" || op === "down") state.selected = op === "up" ? n - 1 : n + 1;
  if (op === "copy") state.selected = n + 1;
  if (op === "remove") state.selected = null;
  listOp(["blocks"], op, n);
  say({
    up: `${label} moved up.`,
    down: `${label} moved down.`,
    copy: `${label} duplicated.`,
    remove: `${label} removed. Press Undo to bring it back.`,
  }[op]);
}

// Starting content for a new section: a copy of one already on the site if
// there is one (it shows the client what the section is for), otherwise
// each box filled with its own name.
function sampleBlock(type) {
  for (const p of state.pages.map((x) => x.path)) {
    const found = (docFor(p).doc.toJS()?.blocks ?? []).find((b) => b.type === type.name);
    if (found) return structuredClone(found);
  }
  return { type: type.name, ...placeholder(type.fields) };
}
function placeholder(fields) {
  const out = {};
  for (const f of fields ?? []) {
    if (f.default !== undefined) { out[f.name] = f.default; continue; }
    switch (f.widget) {
      case "string": case "text": out[f.name] = f.label ?? f.name; break;
      case "markdown": out[f.name] = "Write something here."; break;
      case "number": out[f.name] = 0; break;
      case "boolean": out[f.name] = false; break;
      case "select": { const o = f.options?.[0]; out[f.name] = typeof o === "object" ? o.value : o ?? ""; break; }
      case "object": out[f.name] = placeholder(f.fields); break;
      case "list":
        out[f.name] = f.fields ? [placeholder(f.fields), placeholder(f.fields)]
          : f.field ? [placeholder([f.field])[f.field.name]] : ["First item", "Second item"];
        break;
      default: out[f.name] = "";
    }
  }
  return out;
}

let insertAt = 0;
async function openPicker(after) {
  insertAt = after == null ? blockCount() : after + 1;
  const types = state.pageFields.find((f) => f.name === "blocks").types.filter((t) => t.name !== "raw");
  const grid = $("picker-grid");
  grid.replaceChildren();
  $("picker").showModal();
  for (const type of types) {
    const block = sampleBlock(type);
    const frame = Object.assign(document.createElement("iframe"), { tabIndex: -1, title: "" });
    frame.setAttribute("sandbox", "");
    frame.setAttribute("aria-hidden", "true");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "pick";
    card.append(Object.assign(document.createElement("div"), { className: "thumb" }), Object.assign(document.createElement("span"), { textContent: type.label }));
    card.firstChild.append(frame);
    card.onclick = () => addSection(block);
    grid.append(card);
    // A real preview of the section, drawn with the site's own templates.
    state.render(state.current, { data: { ...pageData(), blocks: [block] } }).then((html) => {
      frame.srcdoc = html.replace(/<head([^>]*)>/i, `<head$1><base href="${SITE_ROOT}"><style>body>*:not(main){display:none!important}</style>`);
    }).catch(() => {});
  }
}

function addSection(block) {
  $("picker").close();
  const n = insertAt;
  remember(state.current, "");
  const { doc } = docFor(state.current);
  const seq = doc.getIn(["blocks"], true);
  if (seq?.items) seq.items.splice(n, 0, doc.createNode(block));
  else doc.setIn(["blocks"], [block]);
  try { writePage(state.current); } catch (err) { return say(err.message, { sticky: true }); }
  state.selected = n;
  changed({ redrawPanel: true });
  say(`${typeLabel(n)} added. Click its words to change them.`);
  scrollToBlock = n;
}
let scrollToBlock = null;

// The floating toolbar on the section under the pointer (or with focus).
function sectionBar(doc) {
  const bar = doc.createElement("div");
  bar.className = "ed-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Section tools");
  bar.hidden = true;
  const name = doc.createElement("span");
  name.className = "ed-bar-name";
  bar.append(name);
  let current = null;
  const tools = [
    ["Move up", "up"], ["Move down", "down"], ["Duplicate", "copy"],
    ["Remove", "remove"], ["Settings", "settings"], ["+ Add section below", "add"],
  ];
  for (const [label, op] of tools) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.op = op;
    if (op === "remove") b.className = "ed-danger";
    bar.append(b);
  }
  bar.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const op = e.target.closest("button")?.dataset.op;
    if (!op || current == null) return;
    if (op === "settings") select(current);
    else if (op === "add") openPicker(current);
    else sectionOp(op, current);
  }, true);
  doc.body.append(bar);

  const win = doc.defaultView;
  // How far down the window a pinned header (sticky or fixed menu bar)
  // reaches, so the toolbar can sit below it instead of covering it.
  const pinnedTop = () => {
    let bottom = 0;
    for (const x of [win.innerWidth / 2, 8, win.innerWidth - 8]) {
      for (let el = doc.elementFromPoint(x, 1); el && el !== doc.body; el = el.parentElement) {
        if (bar.contains(el)) break;
        const pos = win.getComputedStyle(el).position;
        if (pos === "fixed" || pos === "sticky") { bottom = Math.max(bottom, el.getBoundingClientRect().bottom); break; }
      }
    }
    return bottom;
  };
  const place = (n) => {
    const el = [...doc.querySelectorAll(`[data-ed-block="${n}"]`)].find((x) => x.getBoundingClientRect().height > 0);
    if (!el) return;
    current = n;
    name.textContent = typeLabel(n);
    bar.querySelector('[data-op="up"]').disabled = n === 0;
    bar.querySelector('[data-op="down"]').disabled = n === blockCount() - 1;
    bar.hidden = false;
    const r = el.getBoundingClientRect();
    // At the top of its section, but never under a pinned header, and
    // never past the section's own bottom edge.
    const top = Math.min(Math.max(r.top, pinnedTop()) + 8, r.bottom - bar.offsetHeight - 8);
    bar.style.top = `${Math.max(top, r.top + 8) + win.scrollY}px`;
    bar.style.left = `${Math.max(8, r.right + win.scrollX - bar.offsetWidth - 8)}px`;
  };
  win.addEventListener("scroll", () => { if (!bar.hidden && current != null) place(current); }, { passive: true });
  doc.addEventListener("mouseover", (e) => {
    if (bar.contains(e.target)) return;
    const b = e.target.closest?.("[data-ed-block]");
    if (b) place(+b.dataset.edBlock);
  });
  doc.addEventListener("focusin", (e) => {
    if (bar.contains(e.target)) return;
    const b = e.target.closest?.("[data-ed-block]");
    if (b) place(+b.dataset.edBlock);
  });
  if (typeof state.selected === "number") place(state.selected);
}

// --------------------------------------------------------- typing in place ---
function startEdit(el) {
  const doc = el.ownerDocument;
  const path = state.fields[+el.dataset.edF];
  const def = fieldAt(state.pageFields, pageData(), path);
  const value = String(valueAt(path) ?? "");
  select(path[1], path);
  // Long writing (paragraphs, lists) is edited in the panel's text box.
  if (def?.widget === "markdown" || /\n/.test(value.trim())) return;

  const rich = /<[a-z][^>]*>/i.test(value);
  const shown = rich ? value : escapeText(htmlToText(doc, value));
  el.contentEditable = rich ? "true" : "plaintext-only";
  el.innerHTML = shown;
  el.focus();
  doc.getSelection().selectAllChildren(el);

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("blur", onBlur);
    el.removeAttribute("contenteditable");
    const next = rich ? cleanHtml(el) : escapeText(el.textContent);
    if (keep && next !== shown) setValue(path, next);
    else draw();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
    else if (e.key === "Enter" && !(e.shiftKey && rich)) { e.preventDefault(); finish(true); }
    else if (e.key === "Enter") { e.preventDefault(); doc.execCommand("insertLineBreak"); }
  };
  const onBlur = () => finish(true);
  el.addEventListener("keydown", onKey);
  el.addEventListener("blur", onBlur);
  // Paste as plain words, never someone else's formatting.
  el.addEventListener("paste", (e) => {
    e.preventDefault();
    doc.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " "));
  });
}

const PREVIEW_CSS = `
  [data-ed-f] { cursor: text; }
  [data-ed-f]:hover, [data-ed-near]:hover { outline: 2px dashed #2357d9; outline-offset: 3px; }
  [data-ed-f]:focus-visible { outline: 3px solid #2357d9; outline-offset: 3px; }
  [contenteditable] { outline: 3px solid #2357d9 !important; outline-offset: 3px; cursor: text; }
  [data-ed-block].ed-selected { box-shadow: inset 0 0 0 3px #2357d9; }
  a, button, summary, label { cursor: pointer; }
  /* The section toolbar. Reset first so the site's own styles can't reach it. */
  .ed-bar, .ed-bar * { all: revert; box-sizing: border-box; font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: normal; text-transform: none; }
  .ed-bar { position: absolute; z-index: 2147483647; display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
            max-width: calc(100vw - 16px); padding: 4px; background: #1d2433; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
  .ed-bar[hidden] { display: none; }
  .ed-bar-name { color: #c9d2e3; padding: 0 6px; }
  .ed-bar button { min-height: 32px; padding: 0 10px; border: 0; border-radius: 6px; background: #fff; color: #1d2433; cursor: pointer; }
  .ed-bar button:hover { background: #e3e9f8; }
  .ed-bar button:disabled { opacity: .45; cursor: default; }
  .ed-bar button:focus-visible { outline: 3px solid #8fb0ff; outline-offset: 1px; }
  .ed-bar .ed-danger { color: #b42318; }
`;

function wire(doc) {
  const style = doc.createElement("style");
  style.textContent = PREVIEW_CSS;
  doc.head.append(style);
  for (const el of doc.querySelectorAll("[data-ed-f]")) {
    el.tabIndex = 0;
    el.setAttribute("aria-label", `Edit: ${el.textContent.trim().slice(0, 60)}`);
  }
  sectionBar(doc);
  doc.addEventListener("click", (e) => {
    if (e.target.closest("[contenteditable], .ed-bar")) return;
    // Nothing in the preview navigates: links and buttons are for editing.
    e.preventDefault();
    const f = e.target.closest("[data-ed-f]");
    if (f) return startEdit(f);
    const near = e.target.closest("[data-ed-near]");
    if (near) { const p = state.fields[+near.dataset.edNear]; return select(p[1], p); }
    const b = e.target.closest("[data-ed-block]");
    if (b) select(+b.dataset.edBlock);
  }, true);
  doc.addEventListener("keydown", (e) => {
    if (e.target.closest?.("[contenteditable]")) return;
    if (e.key === "Enter" && e.target.matches?.("[data-ed-f]")) { e.preventDefault(); startEdit(e.target); }
    else shortcuts(e);
  });
  doc.addEventListener("submit", (e) => e.preventDefault(), true);
}

// ---------------------------------------------------------------- render ---
function listPages() {
  state.pages = [...state.files.keys()]
    .filter((p) => p.startsWith("_content/"))
    .map((path) => ({ path, title: splitFrontMatter(state.files.get(path), YAML).data.title || path }))
    .sort((a, b) => (a.path.endsWith("/index.html") ? -1 : b.path.endsWith("/index.html") ? 1 : a.title.localeCompare(b.title)));
  $("page-select").replaceChildren(...state.pages.map((p) => new Option(p.title, p.path)));
}

let drawing = 0;
async function draw() {
  const ticket = ++drawing;
  const frame = $("frame");
  const scroll = frame.contentWindow?.scrollY ?? 0;
  let out;
  try {
    out = await markedRender((data) => state.render(state.current, { data, editing: true }), pageData(), state.unsafe);
  } catch (err) {
    console.error(err);
    say("This page couldn't be shown. Your changes are safe; please let Blake know.", { sticky: true });
    return;
  }
  if (ticket !== drawing) return; // a newer change is already on its way
  state.fields = out.fields;
  // Relative links, styles and pictures resolve against the live site.
  const html = out.html.replace(/<head([^>]*)>/i, `<head$1><base href="${SITE_ROOT}">`);
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    mapDom(doc, out.fields);
    wire(doc);
    highlight();
    frame.contentWindow.scrollTo(0, scroll);
    if (scrollToBlock != null) {
      doc.querySelector(`[data-ed-block="${scrollToBlock}"]`)?.scrollIntoView({ block: "start" });
      scrollToBlock = null;
    }
  }, { once: true });
  frame.srcdoc = html;
}

async function goTo(path) {
  state.current = path;
  state.selected = null;
  $("panel").hidden = true;
  $("page-select").value = path;
  await draw();
}

function shortcuts(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); restore(state.undo, state.redo); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); restore(state.redo, state.undo); }
}

// ------------------------------------------------------------------ open ---
async function open() {
  try {
    loading("Loading your website…");
    await loadFiles();
    state.render = makeRenderer({ Liquid, Marked, YAML, files: state.files });
    listPages();
    show("workspace");
    offerDraft();
    await goTo(state.pages[0].path);
    say("Click any words on the page to change them.");
  } catch (err) {
    if (err instanceof SignedOut) {
      try { localStorage.removeItem(TOKEN_KEY); } catch {}
      return askToSignIn("Your sign-in has expired. Please sign in again.");
    }
    console.error(err);
    fail(`The editor couldn't load your website (${err.message}). Check your internet connection and reload.`);
  }
}

async function start() {
  try {
    const res = await fetch(new URL("admin/config.yml", SITE_ROOT));
    state.config = YAML.parse(await res.text(), { merge: true });
  } catch {
    return fail("The editor's settings file is missing. Please let Blake know.");
  }
  state.pageFields = state.config.collections.find((c) => c.folder === "_content")?.fields ?? [];
  state.repo = state.config.backend.repo;
  // ?branch= lets Blake try the editor on a test branch.
  state.branch = new URLSearchParams(location.search).get("branch") || state.config.backend.branch || "main";
  $("site-name").textContent = state.config.site_url ? new URL(state.config.site_url).hostname : "Your website";

  $("page-select").onchange = (e) => goTo(e.target.value);
  $("page-settings").onclick = () => select("page");
  $("add-section").onclick = () => openPicker(typeof state.selected === "number" ? state.selected : null);
  $("picker-close").onclick = () => $("picker").close();
  $("panel-close").onclick = () => select(null);
  $("panel-form").addEventListener("submit", (e) => e.preventDefault()); // Enter in a box must not reload
  $("undo").onclick = () => restore(state.undo, state.redo);
  $("redo").onclick = () => restore(state.redo, state.undo);
  document.addEventListener("keydown", (e) => {
    if (!e.target.closest?.("input, textarea, select")) shortcuts(e);
  });
  for (const [id, mobile] of [["view-desktop", false], ["view-mobile", true]]) {
    $(id).onclick = () => {
      $("frame-wrap").classList.toggle("mobile", mobile);
      $("view-desktop").setAttribute("aria-pressed", String(!mobile));
      $("view-mobile").setAttribute("aria-pressed", String(mobile));
    };
  }
  state.token = storedToken();
  if (state.token) open();
  else askToSignIn();
}

start();
