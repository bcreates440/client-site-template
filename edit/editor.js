// The click-to-edit website editor.
//
// Reads the site's own files from GitHub, draws the real page with the same
// templates Jekyll uses (render.js), finds which words and pictures came from
// which value (fields.js, dom.js), and lets the client click any of them to
// change it. Every change - words, pictures, sections, pages - is kept on
// this computer until it's published.
//
// Settings come from ../admin/config.yml (the same file the backup editor
// at /admin/ uses): which repo and branch, the sign-in worker, where
// pictures go, and every section type and field. A few site-specific extras
// (e.g. Montaire's thumbnail folder) live in edit/settings.yml.

import YAML from "https://unpkg.com/yaml@2.9.1/browser/index.js";
import { Liquid } from "https://cdn.jsdelivr.net/npm/liquidjs@10.30.0/dist/liquid.browser.mjs";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@18.1.2/lib/marked.esm.js";
// The editor's own files are loaded with this file's version stamp
// (index.html adds ?v=<build time>), so after an update a browser can never
// mix an old copy of one file with a new copy of another.
const V = new URL(import.meta.url).search;
const { makeRenderer, splitFrontMatter } = await import(`./render.js${V}`);
const { markedRender, probeImages, valuePaths } = await import(`./fields.js${V}`);
const { mapDom, mapImages, escapeText, htmlToText, cleanHtml } = await import(`./dom.js${V}`);
const { drawForm, field, fieldAt, blockType } = await import(`./panel.js${V}`);
const { shrink, fileName, loadUploads, saveUploads } = await import(`./media.js${V}`);

const $ = (id) => document.getElementById(id);
const SITE_ROOT = new URL("../", location.href).href;
const TOKEN_KEY = "site-editor.token";
// Page settings a client should never need to touch (they break links).
const HIDDEN_PAGE_FIELDS = new Set(["slug", "permalink", "layout", "blocks"]);

const state = {
  config: null,      // admin/config.yml, parsed
  settings: {},      // edit/settings.yml, parsed (optional)
  pageFields: [],    // the pages collection's field list
  dataFiles: [],     // site-wide files from config.yml: [{ name, label, file, fields, description }]
  repo: "",
  branch: "",
  base: "",          // commit the files were loaded from
  token: "",
  tree: new Set(),      // every path in the repo, as loaded
  files: new Map(),     // repo path -> current text (what the renderer reads)
  original: new Map(),  // repo path -> text as loaded
  docs: new Map(),      // path -> { doc, body } (parsed YAML / front matter)
  uploads: {},          // repo path -> Blob: new pictures waiting to be published
  urls: {},             // repo path -> blob: URL for showing them
  unsafe: new Set(),    // field kinds that can't be marked (see fields.js)
  render: null,
  pages: [],
  current: "",
  fields: [],           // marker id -> path, for the page on screen
  images: [],           // picture index -> path, for the page on screen
  selected: null,       // section index, "page", or null
  dataFile: null,       // site-wide file shown in the panel, or null
  undo: [],
  redo: [],
};
const target = () => state.dataFile ?? state.current;

// ---------------------------------------------------------------- status ---
let statusTimer;
function say(msg, { sticky = false } = {}) {
  $("status").textContent = msg;
  clearTimeout(statusTimer);
  if (!sticky && msg) statusTimer = setTimeout(() => ($("status").textContent = ""), 5000);
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
  state.tree = new Set(tree.tree.map((t) => t.path));
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

// ------------------------------------------------------------- file data ---
// Pages are front matter + body; site-wide files are plain YAML. Both are
// edited as YAML documents, so comments, key order and every field the
// editor doesn't know about survive.
const FM = /^---\n([\s\S]*?\n)?---\n?([\s\S]*)$/;
const isData = (path) => /\.ya?ml$/.test(path);
function docFor(path) {
  if (!state.docs.has(path)) {
    const text = state.files.get(path) ?? "";
    if (isData(path)) state.docs.set(path, { doc: YAML.parseDocument(text), body: null });
    else {
      const m = text.match(FM);
      state.docs.set(path, { doc: YAML.parseDocument(m?.[1] ?? ""), body: m?.[2] ?? "" });
    }
  }
  return state.docs.get(path);
}
const dataOf = (path) => docFor(path).doc.toJS() ?? {};
const pageData = (path = state.current) => dataOf(path);
const valueAt = (path, file = target()) => path.reduce((o, p) => o?.[p], dataOf(file));

// Writes a file back from its YAML document, after reading the result back
// to prove it says what we meant. If it doesn't, nothing is stored.
function writeFile(path) {
  const { doc, body } = docFor(path);
  const yaml = doc.toString({ lineWidth: 0 });
  const text = body == null ? yaml : `---\n${yaml}---\n${body}`;
  const reread = YAML.parse(body == null ? text : text.match(FM)[1]);
  if (JSON.stringify(reread) !== JSON.stringify(doc.toJS())) throw new Error("A change didn't save cleanly, so it was not kept.");
  // Back to exactly what it said when loaded (e.g. added then removed)? Keep
  // the original text, spacing and all, so nothing is published for nothing.
  const orig = state.original.get(path);
  if (orig != null && sameContent(orig, body == null ? null : body, reread)) {
    state.files.set(path, orig);
    state.docs.delete(path);
    return;
  }
  state.files.set(path, text);
}
function sameContent(orig, body, data) {
  try {
    if (body == null) return JSON.stringify(YAML.parse(orig)) === JSON.stringify(data);
    const m = orig.match(FM);
    return m && m[2] === body && JSON.stringify(YAML.parse(m[1] ?? "")) === JSON.stringify(data);
  } catch { return false; }
}

// --------------------------------------------------- undo, redo, drafts ---
let lastChange = { key: "", at: 0 };
// One undo step can cover several files (deleting a page also takes it out
// of the menu). A file that didn't exist is remembered as null.
function remember(files, key = "") {
  const now = Date.now();
  if (key && key === lastChange.key && now - lastChange.at < 1500) { lastChange.at = now; return; }
  lastChange = { key, at: now };
  state.undo.push([].concat(files).map((file) => ({ file, text: state.files.get(file) ?? null })));
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
}
function restore(from, to) {
  const step = from.pop();
  if (!step) return;
  to.push(step.map(({ file }) => ({ file, text: state.files.get(file) ?? null })));
  for (const { file, text } of step) {
    if (text == null) state.files.delete(file); else state.files.set(file, text);
    state.docs.delete(file);
  }
  lastChange = { key: "", at: 0 };
  const pagesChanged = step.some(({ file }) => file.startsWith("_content/"));
  if (pagesChanged) listPages();
  if (!state.files.has(state.current)) { changed(); return goTo(state.pages[0].path); }
  changed({ redrawPanel: true });
}

const draftKey = () => `site-editor.draft:${state.repo}@${state.branch}`;
function changedFiles() {
  const paths = new Set([...state.original.keys(), ...state.files.keys()]);
  return [...paths].filter((p) => state.original.get(p) !== state.files.get(p))
    .map((p) => [p, state.files.get(p) ?? null]);
}
function saveDraft() {
  const files = Object.fromEntries(changedFiles());
  try {
    if (Object.keys(files).length || Object.keys(state.uploads).length) {
      localStorage.setItem(draftKey(), JSON.stringify({ base: state.base, saved: Date.now(), files }));
    } else localStorage.removeItem(draftKey());
  } catch {
    say("Couldn't save a copy on this computer - publish soon so nothing is lost.", { sticky: true });
  }
}
async function offerDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch {}
  const uploads = await loadUploads(draftKey());
  if (!draft?.files || (!Object.keys(draft.files).length && !Object.keys(uploads).length)) return;
  const when = new Date(draft.saved).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  $("notice-text").textContent = `You have changes from ${when} that haven't been published yet.`;
  $("notice").hidden = false;
  $("notice-keep").onclick = () => {
    for (const [p, t] of Object.entries(draft.files)) {
      if (t == null) state.files.delete(p); else state.files.set(p, t);
      state.docs.delete(p);
    }
    for (const [p, blob] of Object.entries(uploads)) addUpload(p, blob);
    $("notice").hidden = true;
    listPages();
    if (!state.files.has(state.current)) state.current = state.pages[0].path;
    changed({ redrawPanel: true });
    say("Your earlier changes are back.");
  };
  $("notice-discard").onclick = () => {
    try { localStorage.removeItem(draftKey()); } catch {}
    saveUploads(draftKey(), {});
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
function setValues(pairs, key) {
  const file = target();
  remember(file, key);
  const { doc } = docFor(file);
  for (const [path, value] of pairs) doc.setIn(path, value);
  try { writeFile(file); } catch (err) { state.docs.delete(file); return say(err.message, { sticky: true }); }
  changed();
}
const setValue = (path, value) => setValues([[path, value]], JSON.stringify([target(), path]));

function listOp(path, op, i, item) {
  const file = target();
  remember(file);
  const { doc } = docFor(file);
  const seq = path.length ? doc.getIn(path, true) : doc.contents;
  if (op === "add") {
    if (seq?.items) seq.items.push(doc.createNode(item));
    else if (path.length) doc.setIn(path, [item]);
    else doc.contents = doc.createNode([item]);
  } else if (op === "remove") {
    seq.items.splice(i, 1);
  } else if (op === "copy") {
    seq.items.splice(i + 1, 0, doc.createNode(seq.items[i].toJSON()));
  } else {
    const j = op === "up" ? i - 1 : i + 1;
    [seq.items[i], seq.items[j]] = [seq.items[j], seq.items[i]];
  }
  try { writeFile(file); } catch (err) { state.docs.delete(file); return say(err.message, { sticky: true }); }
  changed({ redrawPanel: true });
}

// ------------------------------------------------------------- pictures ---
const mediaFolder = () => String(state.config.media_folder ?? "images").replace(/^\/|\/$/g, "");
const publicFolder = () => String(state.config.public_folder ?? state.config.media_folder ?? "images").replace(/^\/|\/$/g, "");
function addUpload(repoPath, blob) {
  state.uploads[repoPath] = blob;
  if (state.urls[repoPath]) URL.revokeObjectURL(state.urls[repoPath]);
  state.urls[repoPath] = URL.createObjectURL(blob);
}

async function replacePicture(path, file) {
  say("Getting your picture ready…", { sticky: true });
  try {
    const big = await shrink(file);
    const name = fileName(file.name, big.ext);
    const value = `${publicFolder()}/${name}`;
    addUpload(`${mediaFolder()}/${name}`, big.blob);
    // Montaire-style sites show a small copy in grids (edit/settings.yml).
    const thumbs = state.settings.thumbnails;
    if (thumbs?.folder) {
      const small = await shrink(file, thumbs.size ?? 640);
      addUpload(`${thumbs.folder.replace(/\/$/, "")}/${value}`, small.blob);
    }
    await saveUploads(draftKey(), state.uploads);

    // Fill in the picture's size too, where the section has boxes for it
    // (stops the page jumping while pictures load).
    const parent = path.slice(0, -1), key = path.at(-1);
    const sibling = (n) => fieldAt(state.pageFields, pageData(), [...parent, n]);
    const pairs = [[path, value]];
    if (sibling(`${key}_width`)) pairs.push([[...parent, `${key}_width`], big.width]);
    if (sibling(`${key}_height`)) pairs.push([[...parent, `${key}_height`], big.height]);
    setValues(pairs);
    drawPanel(path);

    // The old description almost never fits the new picture: take the client
    // straight to it.
    const altName = [`${key}_alt`, "alt", "image_alt"].find((n) => sibling(n));
    if (altName) {
      const empty = !String(valueAt([...parent, altName]) ?? "").trim();
      say(empty
        ? "New picture added. Now describe it in the highlighted box - blind visitors and Google rely on it."
        : "New picture added. Check the highlighted description still matches it - blind visitors and Google rely on it.", { sticky: true });
      drawPanel([...parent, altName]);
      $("panel-form").querySelector(`[data-path='${JSON.stringify([...parent, altName])}']`)?.select?.();
    } else say("New picture added. It goes live when you publish.");
  } catch (err) {
    console.error(err);
    say(err.message || "That picture couldn't be used. Please try a different one.", { sticky: true });
  }
}

// The picture control in the panel: what's there now, and a Replace button.
function mediaControl(def, value, path, labelled) {
  const wrap = document.createElement("div");
  wrap.className = "media";
  if (def.widget === "file") {
    wrap.append(Object.assign(document.createElement("p"), {
      className: "hint", textContent: "Videos can't be changed here yet. Ask Blake if this one needs replacing.",
    }));
    return labelled(def, path, wrap);
  }
  const src = uploadUrl(value) || previewSrc(path);
  if (src) wrap.append(Object.assign(document.createElement("img"), { src, alt: "" }));
  const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", hidden: true });
  input.onchange = () => input.files[0] && replacePicture(path, input.files[0]);
  const btn = Object.assign(document.createElement("button"), {
    type: "button", className: "btn-tool", textContent: value ? "Replace picture…" : "Add a picture…",
  });
  btn.onclick = () => input.click();
  wrap.append(btn, input);
  return labelled(def, path, wrap);
}
// The in-browser copy of a picture that hasn't been published yet, if any.
function uploadUrl(value) {
  const v = String(value ?? "");
  if (!v.startsWith(`${publicFolder()}/`)) return "";
  return state.urls[`${mediaFolder()}/${v.slice(publicFolder().length + 1)}`] ?? "";
}
// What the preview shows for a picture field.
function previewSrc(path) {
  const i = state.images.findIndex((p) => JSON.stringify(p) === JSON.stringify(path));
  const el = i >= 0 && $("frame").contentDocument?.querySelector(`[data-ed-img="${i}"]`);
  return el ? el.currentSrc || el.getAttribute("src") || el.getAttribute("poster") : "";
}

// Swap the address of any not-yet-published picture for its in-browser copy.
function withUploads(html) {
  for (const [repoPath, url] of Object.entries(state.urls)) {
    const tail = repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(`(["'(])[^"'()\\s]*${tail}(?=["')])`, "g"), `$1${url}`);
  }
  return html;
}

// --------------------------------------------------------------- links ---
// Pages are linked the way this site already links them: /about/ style
// when its pages end in a slash, about.html style otherwise.
function pageLink(permalink) {
  const slashStyle = state.pages.some((p) => p.permalink?.endsWith("/") && p.permalink !== "/");
  if (slashStyle) return permalink;
  return permalink === "/" ? "index.html" : permalink.replace(/^\//, "");
}
function linkOptions() {
  return [
    ...state.pages.map((p) => ({ label: `Page: ${p.title}`, value: pageLink(p.permalink ?? "/") })),
    ...Object.entries(state.settings.links ?? {}).map(([value, label]) => ({ label, value })),
  ];
}

// ---------------------------------------------------------------- panel ---
const panelCtx = (focusPath) => ({ set: setValue, list: listOp, focusPath, links: linkOptions, media: mediaControl });

function drawPanel(focusPath) {
  const panel = $("panel"), form = $("panel-form");
  if (state.selected == null && !state.dataFile) { panel.hidden = true; return; }
  panel.hidden = false;

  if (state.dataFile) {
    const entry = state.dataFiles.find((d) => d.file === state.dataFile);
    $("panel-title").textContent = entry.label;
    const data = dataOf(entry.file);
    const intro = entry.description ? [Object.assign(document.createElement("p"), { className: "hint", textContent: entry.description.trim() })] : [];
    // A file that is just a list (root: true) is edited as that list.
    if (entry.fields.length === 1 && entry.fields[0].root) {
      form.replaceChildren(...intro, field(entry.fields[0], Array.isArray(data) ? data : [], [], panelCtx(focusPath)));
    } else {
      drawForm(form, entry.fields, data, [], panelCtx(focusPath));
      form.prepend(...intro);
    }
  } else if (state.selected === "page") {
    $("panel-title").textContent = "Page settings";
    drawForm(form, state.pageFields.filter((f) => !HIDDEN_PAGE_FIELDS.has(f.name)), pageData(), [], panelCtx(focusPath));
    form.prepend(googlePreview());
    if (!isHome(state.current)) {
      const del = Object.assign(document.createElement("button"), { type: "button", className: "btn-danger", textContent: "Delete this page…" });
      del.onclick = () => askDeletePage();
      form.append(del);
    }
  } else {
    const block = pageData().blocks?.[state.selected];
    const type = block && blockType(state.pageFields, block.type);
    if (!type) { state.selected = null; panel.hidden = true; return; }
    $("panel-title").textContent = type.label;
    if (block.type === "raw") {
      form.replaceChildren(Object.assign(document.createElement("p"), {
        className: "locked",
        textContent: "This section was built specially, so it can't be changed here. You can still move or remove it. Ask Blake if it needs changing.",
      }));
      return;
    }
    drawForm(form, type.fields, block, ["blocks", state.selected], panelCtx(focusPath));
  }
  if (focusPath) {
    let el = form.querySelector(`[data-path='${JSON.stringify(focusPath)}']`);
    // A picture's control is a wrapper: focus its button.
    if (el && !el.matches("input, select, textarea, button")) el = el.querySelector("button, input, select, textarea");
    if (el) { el.scrollIntoView({ block: "center" }); el.focus({ preventScroll: true }); }
  }
}

// How this page will look in Google, updating as the client types.
function googlePreview() {
  const box = document.createElement("div");
  box.className = "google";
  const update = () => {
    const d = pageData();
    const title = htmlToText(document, String(d.title ?? ""));
    const desc = htmlToText(document, String(d.description ?? ""));
    const url = (state.config.display_url ?? SITE_ROOT).replace(/\/$/, "") + (d.permalink ?? "/");
    box.replaceChildren(
      Object.assign(document.createElement("p"), { className: "google-label", textContent: "How this page looks in Google" }),
      Object.assign(document.createElement("p"), { className: "google-url", textContent: url }),
      Object.assign(document.createElement("p"), { className: "google-title", textContent: title || "(no title yet)" }),
      Object.assign(document.createElement("p"), { className: "google-desc", textContent: desc || "(no description yet)" }),
      Object.assign(document.createElement("p"), {
        className: "hint",
        textContent: `Title: ${title.length} characters${title.length > 60 ? " - Google will cut it short; aim for under 60." : "."} `
          + `Description: ${desc.length} characters${desc.length > 160 ? " - aim for 150-160." : desc.length < 70 ? " - a sentence or two (150-160 characters) works best." : "."}`,
      }),
    );
  };
  update();
  box.addEventListener("ed-refresh", update);
  return box;
}

function select(block, focusPath) {
  state.selected = block;
  state.dataFile = null;
  highlight();
  drawPanel(focusPath);
}
function openDataFile(file) {
  state.selected = null;
  state.dataFile = file;
  highlight();
  drawPanel();
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
  state.dataFile = null;
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
    const found = (pageData(p).blocks ?? []).find((b) => b.type === type.name);
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
      frame.srcdoc = withUploads(html).replace(/<head([^>]*)>/i, `<head$1><base href="${SITE_ROOT}"><style>body>*:not(main){display:none!important}</style>`);
    }).catch(() => {});
  }
}

let scrollToBlock = null;
function addSection(block) {
  $("picker").close();
  const n = insertAt;
  state.dataFile = null;
  remember(state.current);
  const { doc } = docFor(state.current);
  const seq = doc.getIn(["blocks"], true);
  if (seq?.items) seq.items.splice(n, 0, doc.createNode(block));
  else doc.setIn(["blocks"], [block]);
  try { writeFile(state.current); } catch (err) { state.docs.delete(state.current); return say(err.message, { sticky: true }); }
  state.selected = n;
  changed({ redrawPanel: true });
  say(`${typeLabel(n)} added. Click its words to change them.`);
  scrollToBlock = n;
}

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

// ----------------------------------------------------------------- pages ---
const isHome = (path) => {
  const p = state.pages.find((x) => x.path === path);
  return p?.permalink === "/" || p?.permalink === "/index.html" || path === "_content/index.html";
};
const navEntry = () => state.dataFiles.find((d) => /(^|\/)nav\.ya?ml$/.test(d.file));
function navList(entry = navEntry()) {
  if (!entry) return null;
  const f = entry.fields.find((x) => x.widget === "list") ?? entry.fields[0];
  return { field: f, path: f.root ? [] : [f.name] };
}
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";

function openNewPage() {
  const from = $("newpage-from");
  from.replaceChildren(new Option("A blank page", ""), ...state.pages.map((p) => new Option(`A copy of "${p.title}"`, p.path)));
  $("newpage-title").value = "";
  $("newpage-menu").checked = !!navEntry();
  $("newpage-menu").parentElement.hidden = !navEntry();
  $("newpage-error").textContent = "";
  $("newpage").showModal();
  $("newpage-title").focus();
}

function createPage(e) {
  e.preventDefault();
  const title = $("newpage-title").value.trim();
  if (!title) { $("newpage-error").textContent = "Give the page a name first."; return; }
  let slug = slugify(title), n = 2;
  while (state.files.has(`_content/${slug}.html`)) slug = `${slugify(title)}-${n++}`;
  const path = `_content/${slug}.html`;
  const slashStyle = state.pages.some((p) => p.permalink?.endsWith("/") && p.permalink !== "/");
  const permalink = slashStyle ? `/${slug}/` : `/${slug}.html`;

  // Blank: start with the banner every inner page here begins with, retitled.
  let blocks;
  const from = $("newpage-from").value;
  if (from) blocks = structuredClone(pageData(from).blocks ?? []);
  else {
    const inner = state.pages.find((p) => !isHome(p.path) && pageData(p.path).blocks?.length);
    const first = inner && structuredClone(pageData(inner.path).blocks[0]);
    if (first) {
      for (const k of ["title", "heading"]) if (k in first) first[k] = title;
      // Small labels and opening lines belong to the page it came from.
      for (const k of ["kicker", "eyebrow", "badge", "lede", "sub", "subheading", "intro"]) delete first[k];
    }
    blocks = first ? [first] : [];
  }
  const fm = new YAML.Document({ slug, permalink, title, description: "", blocks });
  const files = [path];
  const nav = $("newpage-menu").checked && navEntry();
  if (nav) files.push(nav.file);
  remember(files);
  state.files.set(path, `---\n${fm.toString({ lineWidth: 0 })}---\n`);

  if (nav) {
    const { field: f, path: listPath } = navList(nav);
    const item = {};
    for (const x of f.fields ?? []) {
      if (["label", "title"].includes(x.name)) item[x.name] = title;
      else if (x.name === "url") item[x.name] = pageLink(permalink);
      else if (x.name === "slug") item[x.name] = slug;
    }
    const { doc } = docFor(nav.file);
    const seq = listPath.length ? doc.getIn(listPath, true) : doc.contents;
    const node = doc.createNode(item);
    // Written the same way as the entry before it ({ one: line } or not).
    node.flow = !!seq.items.at(-1)?.flow;
    seq.items.push(node);
    writeFile(nav.file);
  }
  $("newpage").close();
  listPages();
  goTo(path);
  changed();
  say(`"${title}" added${nav ? " and put in the menu" : ""}. Click any words to change them.`);
}

function askDeletePage() {
  const page = state.pages.find((p) => p.path === state.current);
  $("confirm-text").textContent = `Delete "${page.title}"? It comes out of the menu too. You can undo this until you publish.`;
  $("confirm-yes").onclick = () => { $("confirm").close(); deletePage(page); };
  $("confirm").showModal();
}

function deletePage(page) {
  const nav = navEntry();
  const link = pageLink(page.permalink ?? "");
  const files = [page.path];
  if (nav) files.push(nav.file);
  remember(files);
  state.files.delete(page.path);
  state.docs.delete(page.path);
  if (nav) {
    // Take it out of the menu, including any drop-down underneath an item.
    const { path: listPath } = navList(nav);
    const { doc } = docFor(nav.file);
    const prune = (seq) => {
      if (!seq?.items) return;
      seq.items = seq.items.filter((it) => {
        const v = it.toJSON?.() ?? {};
        return v.url !== link && v.url?.split("#")[0] !== link && v.slug !== page.slug;
      });
      for (const it of seq.items) prune(it.get?.("children", true));
    };
    prune(listPath.length ? doc.getIn(listPath, true) : doc.contents);
    writeFile(nav.file);
  }
  listPages();
  goTo(state.pages[0].path);
  changed();
  say(`"${page.title}" deleted. Press Undo to bring it back.`);
}

// --------------------------------------------------------- typing in place ---
function startEdit(el) {
  const doc = el.ownerDocument;
  const path = state.fields[+el.dataset.edF];
  const def = fieldAt(state.pageFields, pageData(), path);
  const value = String(valueAt(path, state.current) ?? "");
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
  [data-ed-img] { cursor: pointer; }
  [data-ed-f]:hover, [data-ed-near]:hover, [data-ed-img]:hover { outline: 2px dashed #2357d9; outline-offset: 3px; }
  [data-ed-f]:focus-visible, [data-ed-img]:focus-visible { outline: 3px solid #2357d9; outline-offset: 3px; }
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
  for (const el of doc.querySelectorAll("[data-ed-img]")) {
    el.tabIndex = 0;
    el.setAttribute("aria-label", "Change this picture");
  }
  sectionBar(doc);
  doc.addEventListener("click", (e) => {
    if (e.target.closest("[contenteditable], .ed-bar")) return;
    // Nothing in the preview navigates: links and buttons are for editing.
    e.preventDefault();
    const f = e.target.closest("[data-ed-f]");
    if (f) return startEdit(f);
    const img = e.target.closest("[data-ed-img]");
    if (img) { const p = state.images[+img.dataset.edImg]; return select(p[1], p); }
    const near = e.target.closest("[data-ed-near]");
    if (near) { const p = state.fields[+near.dataset.edNear]; return select(p[1], p); }
    const b = e.target.closest("[data-ed-block]");
    if (b) select(+b.dataset.edBlock);
    // The header and footer show site-wide details.
    else if (e.target.closest("header, footer") && state.dataFiles.length) openDataFile(state.dataFiles[0].file);
  }, true);
  doc.addEventListener("keydown", (e) => {
    if (e.target.closest?.("[contenteditable]")) return;
    if (e.key === "Enter" && e.target.matches?.("[data-ed-f]")) { e.preventDefault(); startEdit(e.target); }
    else if (e.key === "Enter" && e.target.matches?.("[data-ed-img]")) { e.preventDefault(); const p = state.images[+e.target.dataset.edImg]; select(p[1], p); }
    else shortcuts(e);
  });
  doc.addEventListener("submit", (e) => e.preventDefault(), true);
}

// ---------------------------------------------------------------- render ---
function listPages() {
  state.pages = [...state.files.keys()]
    .filter((p) => p.startsWith("_content/"))
    .map((path) => {
      const d = splitFrontMatter(state.files.get(path), YAML).data;
      // The home page's title is usually a slogan; call it what it is.
      const home = d.permalink === "/" || d.permalink === "/index.html";
      return { path, title: home ? "Home page" : d.title || path, permalink: d.permalink, slug: d.slug };
    })
    .sort((a, b) => (isHomeEntry(a) ? -1 : isHomeEntry(b) ? 1 : a.title.localeCompare(b.title)));
  $("page-select").replaceChildren(
    ...state.pages.map((p) => new Option(p.title, p.path)),
    new Option("+ Add a page…", "__new"),
  );
  $("page-select").value = state.current;
}
const isHomeEntry = (p) => p.permalink === "/" || p.permalink === "/index.html";

// Picture fields on this page: every value whose field is an image.
function imagePaths(data) {
  return valuePaths(data).filter((p) => p[0] === "blocks" && data.blocks[p[1]]?.type !== "raw"
    && fieldAt(state.pageFields, data, p)?.widget === "image");
}

let drawing = 0;
async function draw() {
  const ticket = ++drawing;
  const frame = $("frame");
  const scroll = frame.contentWindow?.scrollY ?? 0;
  const data = pageData();
  const render = (d) => state.render(state.current, { data: d, editing: true });
  let out, probe, images;
  try {
    out = await markedRender(render, data, state.unsafe);
    images = imagePaths(data);
    probe = images.length ? await probeImages(render, data, images) : "";
  } catch (err) {
    console.error(err);
    say("This page couldn't be shown. Your changes are safe; please let Blake know.", { sticky: true });
    return;
  }
  if (ticket !== drawing) return; // a newer change is already on its way
  state.fields = out.fields;
  state.images = images;
  // Relative links, styles and pictures resolve against the live site.
  const html = withUploads(out.html).replace(/<head([^>]*)>/i, `<head$1><base href="${SITE_ROOT}">`);
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    mapDom(doc, out.fields);
    if (probe) mapImages(doc, probe);
    wire(doc);
    highlight();
    frame.contentWindow.scrollTo(0, scroll);
    if (scrollToBlock != null) {
      doc.querySelector(`[data-ed-block="${scrollToBlock}"]`)?.scrollIntoView({ block: "start" });
      scrollToBlock = null;
    }
    $("panel-form").querySelector(".google")?.dispatchEvent(new Event("ed-refresh"));
  }, { once: true });
  frame.srcdoc = html;
}

async function goTo(path) {
  state.current = path;
  state.selected = null;
  state.dataFile = null;
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
    state.current = "";
    listPages();
    $("site-select").replaceChildren(new Option("Site-wide…", ""), ...state.dataFiles.map((d) => new Option(d.label, d.file)));
    $("site-select").hidden = !state.dataFiles.length;
    show("workspace");
    await offerDraft();
    await goTo(state.pages[0].path);
    say("Click any words or pictures on the page to change them.");
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
  try {
    const res = await fetch("settings.yml");
    if (res.ok) state.settings = YAML.parse(await res.text()) ?? {};
  } catch {}
  state.pageFields = state.config.collections.find((c) => c.folder === "_content")?.fields ?? [];
  state.dataFiles = state.config.collections.flatMap((c) => c.files ?? []);
  state.repo = state.config.backend.repo;
  // ?branch= lets Blake try the editor on a test branch.
  state.branch = new URLSearchParams(location.search).get("branch") || state.config.backend.branch || "main";
  $("site-name").textContent = state.config.site_url ? new URL(state.config.site_url).hostname : "Your website";

  $("page-select").onchange = (e) => {
    if (e.target.value === "__new") { e.target.value = state.current; openNewPage(); }
    else goTo(e.target.value);
  };
  $("site-select").onchange = (e) => { if (e.target.value) openDataFile(e.target.value); e.target.value = ""; };
  $("page-settings").onclick = () => select("page");
  $("add-section").onclick = () => openPicker(typeof state.selected === "number" ? state.selected : null);
  $("picker-close").onclick = () => $("picker").close();
  $("newpage-form").addEventListener("submit", createPage);
  $("newpage-cancel").onclick = () => $("newpage").close();
  $("confirm-no").onclick = () => $("confirm").close();
  $("panel-close").onclick = () => select(null);
  $("panel-form").addEventListener("submit", (e) => e.preventDefault()); // Enter in a box must not reload
  // Keep the Google preview in step with what's typed.
  $("panel-form").addEventListener("input", () => $("panel-form").querySelector(".google")?.dispatchEvent(new Event("ed-refresh")));
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
