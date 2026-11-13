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
const { check, publish, Conflict, updateSitemap } = await import(`./publish.js${V}`);

const $ = (id) => document.getElementById(id);
const SITE_ROOT = new URL("../", location.href).href;
const TOKEN_KEY = "site-editor.token";
// Email sign-in (client-sites-auth/email). Its sessions start "ses." and its
// GitHub calls go through it; GitHub sign-ins call GitHub directly.
const EMAIL_SIGNIN = "https://client-sites-email.bcreates440.workers.dev";
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
  barOff: false,        // section toolbar put away with "Hide toolbar"
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
function githubSignInUrl() {
  const { base_url, auth_endpoint = "auth" } = state.config.backend;
  const url = new URL(auth_endpoint, base_url.replace(/\/?$/, "/"));
  url.searchParams.set("provider", "github");
  url.searchParams.set("site_id", location.hostname);
  url.searchParams.set("scope", "repo");
  return url;
}

// The email sign-in (client-sites-auth/email) answers with the same messages.
function signInPopup(url) {
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
  $("signin-email").onclick = () => signIn(new URL(`${EMAIL_SIGNIN}/login`));
  $("signin").onclick = () => signIn(githubSignInUrl());
  async function signIn(url) {
    $("signin-error").textContent = "";
    try {
      state.token = await signInPopup(url);
      try { localStorage.setItem(TOKEN_KEY, state.token); } catch {}
      await open();
    } catch (err) {
      $("signin-error").textContent = err.message;
    }
  }
}

// ---------------------------------------------------------------- GitHub ---
class SignedOut extends Error {}
async function gh(path, opts = {}) {
  const api = state.token.startsWith("ses.") ? `${EMAIL_SIGNIN}/api` : "https://api.github.com";
  const res = await fetch(`${api}${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
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
const WANTED = /^(_layouts|_includes|_data|_content)\/.+\.(html|ya?ml)$|^_config\.yml$|^admin\/config\.yml$|^sitemap\.xml$/;

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
  $("publish-btn").disabled = !n;
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
// Sites whose host drops ".html" (edit/settings.yml: page_links: extensionless)
// link as contact and ./ instead.
const extensionless = () => state.settings.page_links === "extensionless";
function pageLink(permalink) {
  if (extensionless()) return permalink === "/" || permalink === "/index.html" ? "./" : permalink.replace(/^\//, "").replace(/\.html$/, "");
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

// Pointing at words or a picture on the page lights up its box in the
// settings panel, and pointing at a box lights up its spot on the page.
const LINKED = "[data-ed-f], [data-ed-near], [data-ed-img]";
const pathOf = (el) => el.dataset.edImg != null ? state.images[+el.dataset.edImg] : state.fields[+(el.dataset.edF ?? el.dataset.edNear)];
function markLinked(root, els) {
  root.querySelectorAll(".ed-linked").forEach((x) => x.classList.remove("ed-linked"));
  els.forEach((x) => x.classList.add("ed-linked"));
}
function linkFromPage(doc) {
  doc.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.(LINKED);
    const path = el && pathOf(el);
    const box = path && $("panel-form").querySelector(`[data-path='${JSON.stringify(path)}']`)?.closest(".field");
    markLinked($("panel-form"), box ? [box] : []);
    box?.scrollIntoView({ block: "nearest" });
  });
  doc.addEventListener("mouseout", (e) => { if (!e.relatedTarget) markLinked($("panel-form"), []); });
}
function linkFromPanel(e) {
  const doc = $("frame").contentDocument;
  if (!doc) return;
  const key = e.type === "mouseover" && e.target.closest(".field")?.querySelector("[data-path]")?.dataset.path;
  const spots = key ? [...doc.querySelectorAll(LINKED)].filter((x) => JSON.stringify(pathOf(x)) === key) : [];
  markLinked(doc, spots);
  spots[0]?.scrollIntoView({ block: "nearest" });
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
    ["Hide toolbar", "hide"],
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
    if (op === "hide") return hideBar(true);
    if (op === "settings") select(current);
    else if (op === "add") openPicker(current);
    else sectionOp(op, current);
  }, true);
  doc.body.append(bar);

  // "Hide toolbar" puts it away (it can cover the page, most of all on a
  // phone) until the small corner button brings it back. Kept in state so
  // it stays hidden while the preview redraws after each change.
  const show = doc.createElement("button");
  show.type = "button";
  show.className = "ed-bar ed-show";
  show.textContent = "Show toolbar";
  show.hidden = !state.barOff;
  show.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); hideBar(false); }, true);
  doc.body.append(show);
  const hideBar = (off) => {
    state.barOff = off;
    show.hidden = !off;
    bar.hidden = off;
    if (!off && current != null) place(current);
  };

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
    if (state.barOff) return;
    name.textContent = typeLabel(n);
    bar.querySelector('[data-op="up"]').disabled = n === 0;
    bar.querySelector('[data-op="down"]').disabled = n === blockCount() - 1;
    bar.hidden = false;
    // Measure at the left edge, where it has full room: measured where it
    // last sat it may be squeezed onto extra rows, and then creeps left
    // a step with every mouse move.
    bar.style.left = "0px";
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

// ------------------------------------------------------------- publishing ---
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const liveBranch = () => state.config.backend.branch || "main";
const fileLabel = (p) => state.pages.find((x) => x.path === p)?.title
  ?? state.dataFiles.find((d) => d.file === p)?.label
  ?? (p.startsWith("_content/") ? `a deleted page (${p.slice(9)})` : p);

// New pictures that something still uses (an undone upload is left behind).
function usedUploads() {
  const all = [...state.files.values()].join("\n");
  return Object.fromEntries(Object.entries(state.uploads).filter(([p]) => all.includes(p.split("/").pop())));
}

function publishDialog(...content) {
  $("publish-body").replaceChildren(...content.filter((c) => c != null)); // optional parts are passed as null
  if (!$("publish").open) $("publish").showModal();
}
const closeBtn = (text = "Close") => el("button", { type: "button", className: "btn-tool", textContent: text, onclick: () => $("publish").close() });

function startPublish() {
  const changes = changedFiles();
  if (!changes.length) return say("There's nothing new to publish.");
  if (state.stale) {
    return publishDialog(el("h2", { textContent: "Reload the editor first" }),
      el("p", { textContent: "The website was changed somewhere else while you worked. Reload this page to pick up those changes - yours are saved on this computer and will come back." }),
      el("div", { className: "modal-actions" }, closeBtn("OK")));
  }
  const pages = changes.filter(([p, t]) => p.startsWith("_content/") && t != null)
    .map(([p]) => ({ path: p, title: fileLabel(p), data: dataOf(p) }));
  const problems = check(pages, state.pageFields, (t) => blockType(state.pageFields, t));
  if (problems.length) {
    return publishDialog(
      el("h2", { textContent: "A few things to fix first" }),
      el("p", { textContent: "These need filling in before your changes can go live:" }),
      el("ul", { className: "problems" }, ...problems.slice(0, 12).map((pr) => el("li", {},
        el("span", { textContent: `${pr.where}: ${pr.message} ` }),
        el("button", {
          type: "button", className: "btn-tool", textContent: "Show me",
          onclick: async () => {
            $("publish").close();
            if (state.current !== pr.file) await goTo(pr.file);
            if (pr.path[0] === "blocks") select(pr.path[1], pr.path); else select("page", pr.path);
          },
        })))),
      problems.length > 12 ? el("p", { textContent: `…and ${problems.length - 12} more.` }) : null,
      el("div", { className: "modal-actions" }, closeBtn("OK")),
    );
  }
  const pics = Object.keys(usedUploads()).filter((p) => !state.settings.thumbnails?.folder || !p.startsWith(state.settings.thumbnails.folder)).length;
  const names = [...new Set(changes.map(([p]) => fileLabel(p)))];
  const test = state.branch !== liveBranch();
  publishDialog(
    el("h2", { textContent: test ? "Publish to the test copy?" : "Publish your changes?" }),
    el("p", { textContent: `Changes to: ${names.join(", ")}${pics ? `, plus ${pics} new picture${pics > 1 ? "s" : ""}` : ""}.` }),
    el("p", { className: "hint", textContent: test
      ? `This saves to the test copy ("${state.branch}"), not the live website.`
      : "They'll be on your website about a minute after you publish. You can always go back to an earlier version." }),
    el("div", { className: "modal-actions" },
      el("button", { type: "button", className: "btn-primary", textContent: "Publish now", onclick: () => doPublish(false) }),
      closeBtn("Not yet")),
  );
}

// Pages added, changed or deleted -> the site's sitemap.xml, if it has one.
function sitemapUpdate() {
  if (!state.files.has("sitemap.xml")) return null;
  const pages = changedFiles().filter(([p]) => p.startsWith("_content/")).map(([p, t]) => {
    const src = t ?? state.original.get(p) ?? "";
    return {
      permalink: (YAML.parse(src.match(FM)?.[1] ?? "") ?? {}).permalink,
      kind: t == null ? "deleted" : state.original.has(p) ? "changed" : "added",
    };
  });
  const siteUrl = (YAML.parse(state.files.get("_config.yml") ?? "") ?? {}).url;
  return updateSitemap(state.files.get("sitemap.xml"), pages, siteUrl, new Date().toISOString().slice(0, 10), { extensionless: extensionless() });
}

async function doPublish(overwrite) {
  const names = [...new Set(changedFiles().map(([p]) => fileLabel(p)))];
  const sitemapBefore = state.files.get("sitemap.xml");
  const sitemap = sitemapUpdate();
  if (sitemap != null) state.files.set("sitemap.xml", sitemap);
  const changes = changedFiles();
  const uploads = usedUploads();
  const status = el("p", { textContent: "Starting…" });
  publishDialog(el("h2", { textContent: "Publishing…" }), el("div", { className: "spinner" }), status);
  try {
    const { sha, theirs } = await publish({
      gh, repo: state.repo, branch: state.branch, base: state.base, changes, uploads, overwrite,
      message: `Website editor: ${names.join(", ")}`,
      onStep: (s) => (status.textContent = s),
    });
    // What's on GitHub now is the new starting point.
    for (const [p, t] of changes) { if (t == null) state.original.delete(p); else state.original.set(p, t); }
    // Bring in what was changed elsewhere, so it can't be overwritten later.
    // (The publish itself has already succeeded by this point.)
    try {
      for (const p of theirs.filter((x) => WANTED.test(x))) {
        try {
          const f = await gh(`/repos/${state.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`);
          const text = fromBase64(f.content).replace(/\r\n/g, "\n");
          state.original.set(p, text);
          state.files.set(p, text);
        } catch (err) {
          if (!/ 404 /.test(err.message)) throw err;
          state.original.delete(p); // deleted elsewhere
          state.files.delete(p);
        }
        state.docs.delete(p);
      }
      if (theirs.length) { listPages(); if (!state.files.has(state.current)) state.current = state.pages[0].path; draw(); }
    } catch (err) {
      console.error(err);
      state.stale = true; // the next publish must not trust these copies
    }
    for (const p of Object.keys(uploads)) state.tree.add(p);
    state.base = sha;
    state.uploads = {};
    await saveUploads(draftKey(), {});
    changed();
    afterPublish(sha);
  } catch (err) {
    // Not published: the sitemap goes back to how it was (it's redone next time).
    if (sitemapBefore != null) state.files.set("sitemap.xml", sitemapBefore);
    if (err instanceof Conflict) {
      return publishDialog(
        el("h2", { textContent: "Someone else changed this too" }),
        el("p", { textContent: `While you were editing, these were also changed somewhere else: ${err.files.map(fileLabel).join(", ")}.` }),
        el("p", { className: "hint", textContent: "Publishing yours replaces their version of those. Theirs isn't lost: it stays in History." }),
        el("div", { className: "modal-actions" },
          el("button", { type: "button", className: "btn-primary", textContent: "Publish mine anyway", onclick: () => doPublish(true) }),
          closeBtn("Cancel")),
      );
    }
    if (err instanceof SignedOut) {
      $("publish").close();
      return askToSignIn("Your sign-in expired. Sign in again - your changes are safe on this computer.");
    }
    console.error(err);
    publishDialog(
      el("h2", { textContent: "That didn't publish" }),
      el("p", { textContent: navigator.onLine ? `Something went wrong (${err.message}). Your changes are safe on this computer - try again in a minute.` : "You seem to be offline. Your changes are safe on this computer - publish again once you're back online." }),
      el("div", { className: "modal-actions" },
        el("button", { type: "button", className: "btn-primary", textContent: "Try again", onclick: () => doPublish(overwrite) }),
        closeBtn()),
    );
  }
}

// After publishing: say when it's actually live. GitHub Pages builds the
// site after each commit; its build status says when that's done.
async function afterPublish(sha) {
  const site = state.config.site_url;
  const viewLink = site ? el("a", { className: "btn-primary", href: site, target: "_blank", rel: "noopener", textContent: "View your website" }) : null;
  if (state.branch !== liveBranch()) {
    say("Saved to the test copy.");
    return publishDialog(el("h2", { textContent: "Saved to the test copy" }),
      el("p", { textContent: `Your changes are saved to "${state.branch}". The live website hasn't changed.` }),
      el("div", { className: "modal-actions" }, closeBtn("Done")));
  }
  const note = el("p", { textContent: "Your website is updating. This usually takes about a minute - you can keep working." });
  publishDialog(el("h2", { textContent: "Published" }), note, el("div", { className: "modal-actions" }, closeBtn("Keep working")));
  say("Published. Your website is updating.", { sticky: true });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    let build;
    try { build = await gh(`/repos/${state.repo}/pages/builds/latest`); } catch { break; } // no access to build status: stop checking
    if (build.commit !== sha) continue;
    if (build.status === "built") {
      note.textContent = "Your changes are live.";
      if (viewLink) note.after(viewLink);
      say("Your changes are live.");
      return;
    }
    if (build.status === "errored") {
      note.textContent = "Your changes are saved, but the website couldn't update. Please let Blake know - nothing is lost.";
      say("The website couldn't update - please let Blake know.", { sticky: true });
      return;
    }
  }
  note.textContent = "Published. Your website should show the changes within a few minutes.";
  if (viewLink) note.after(viewLink);
  say("Published.");
}

// --------------------------------------------------------- previous versions ---
let previewing = null;
async function openHistory() {
  const path = state.current;
  publishDialog(el("h2", { textContent: "Previous versions of this page" }), el("div", { className: "spinner" }));
  let commits;
  try {
    commits = await gh(`/repos/${state.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(state.branch)}&per_page=20`);
  } catch (err) {
    return publishDialog(el("h2", { textContent: "Previous versions" }), el("p", { textContent: "They couldn't be loaded just now. Try again in a minute." }), el("div", { className: "modal-actions" }, closeBtn()));
  }
  const when = (c) => new Date(c.commit.author.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  publishDialog(
    el("h2", { textContent: `Previous versions of "${fileLabel(path)}"` }),
    el("p", { className: "hint", textContent: "Look at any earlier version. If you want it back, restore it, then publish." }),
    el("ul", { className: "versions" }, ...commits.map((c, i) => el("li", {},
      el("span", { textContent: `${when(c)}${i === 0 ? " (what's published now)" : ""} - ${c.commit.message.split("\n")[0]}` }),
      i === 0 ? null : el("button", { type: "button", className: "btn-tool", textContent: "Look at it", onclick: () => previewVersion(path, c, when(c)) })))),
    el("div", { className: "modal-actions" }, closeBtn()),
  );
}

async function previewVersion(path, commit, when) {
  $("publish").close();
  try {
    const file = await gh(`/repos/${state.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit.sha}`);
    const text = fromBase64(file.content).replace(/\r\n/g, "\n");
    const data = YAML.parse(text.match(FM)?.[1] ?? "") ?? {};
    const html = await state.render(path, { data });
    previewing = { path, text, when };
    $("history-text").textContent = `You're looking at this page as it was on ${when}.`;
    $("history-bar").hidden = false;
    $("panel").hidden = true;
    // Look, don't touch: nothing in an old version can be clicked.
    $("frame").srcdoc = withUploads(html).replace(/<head([^>]*)>/i, `<head$1><base href="${SITE_ROOT}"><style>*{pointer-events:none!important}</style>`);
  } catch (err) {
    console.error(err);
    say("That version couldn't be shown. Try another one.");
  }
}
function endPreview() {
  previewing = null;
  $("history-bar").hidden = true;
  draw();
}
function restoreVersion() {
  const { path, text, when } = previewing;
  remember(path);
  state.files.set(path, text);
  state.docs.delete(path);
  endPreview();
  changed({ redrawPanel: true });
  say(`The version from ${when} is back. Publish to make it live.`, { sticky: true });
}

// ------------------------------------------------------------------ help ---
function openHelp(first = false) {
  publishDialog(
    el("h2", { textContent: first ? "Welcome to your website editor" : "How the editor works" }),
    el("ol", { className: "tips" },
      el("li", {}, el("strong", { textContent: "Click any words or picture " }), "on the page to change them. Press Enter when you're done, or Esc to cancel."),
      el("li", {}, el("strong", { textContent: "Point at a section " }), "to move it, copy it, remove it, or add a new one below it."),
      el("li", {}, el("strong", { textContent: "Check the phone view " }), "with the Computer / Phone switch at the top."),
      el("li", {}, el("strong", { textContent: "Press Publish " }), "when you're happy. Until then your changes are saved on this computer only, and Undo takes back any step.")),
    el("p", { className: "hint", textContent: "Changed something by mistake after publishing? History lets you look at and restore any earlier version of a page." }),
    first ? null : el("p", { className: "hint" }, "Need a setting that isn't here? ",
      el("a", { href: "../admin/", textContent: "Open the advanced editor" }), "."),
    el("div", { className: "modal-actions" }, closeBtn(first ? "Start editing" : "Close")),
  );
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
  .ed-linked { outline: 3px solid #2357d9 !important; outline-offset: 3px; }
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
  .ed-bar.ed-show { position: fixed; right: 8px; bottom: 8px; padding: 8px 12px; border: 0; color: #fff; cursor: pointer; }
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
  linkFromPage(doc);
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
      // Name pages the way the site's own menu does ("About"), not by their
      // Google title ("About the WWCA | Wyoming Weapons..."). The home page's
      // title is usually a slogan; call it what it is.
      const home = d.permalink === "/" || d.permalink === "/index.html";
      const title = home ? "Home page" : menuName(d) || withoutSiteName(String(d.title ?? "").split(" | ")[0]) || path;
      return { path, title, permalink: d.permalink, slug: d.slug };
    })
    .sort((a, b) => (isHomeEntry(a) ? -1 : isHomeEntry(b) ? 1 : a.title.localeCompare(b.title)));
  $("page-select").replaceChildren(
    ...state.pages.map((p) => new Option(p.title, p.path)),
    new Option("+ Add a page…", "__new"),
  );
  $("page-select").value = state.current;
}
const isHomeEntry = (p) => p.permalink === "/" || p.permalink === "/index.html";

// "Demo: annual event — Jones Uncommon" -> "Demo: annual event", but only when
// the ending is exactly the site's own name; a dash inside a real title stays.
function withoutSiteName(title) {
  const names = [
    (YAML.parse(state.files.get("_config.yml") ?? "") ?? {}).title,
    (YAML.parse(state.files.get("_data/site.yml") ?? "") ?? {}).org_name,
  ].filter(Boolean).map(String);
  for (const n of names) {
    const m = title.match(new RegExp(`^(.+?)\\s+[—–|-]\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    if (m) return m[1];
  }
  return title;
}

// The label a page has in the site's menu, if it's in there.
function menuName(page) {
  const nav = navEntry();
  if (!nav || !state.files.has(nav.file)) return "";
  const { path } = navList(nav);
  const all = [];
  const walk = (items) => (Array.isArray(items) ? items : []).forEach((it) => { all.push(it); walk(it?.children); });
  walk(path.length ? dataOf(nav.file)?.[path[0]] : dataOf(nav.file));
  const bare = (u) => String(u ?? "").replace(/^\.?\//, "").replace(/\.html$/, "").replace(/\/$/, "").split("#")[0];
  const want = bare(page.permalink);
  const hit = all.find((it) => (page.slug && it.slug === page.slug) || (it.url != null && !String(it.url).includes("#") && bare(it.url) === want));
  return hit ? htmlToText(document, String(hit.label ?? hit.title ?? "")) : "";
}

// Picture fields on this page: every value whose field is an image.
function imagePaths(data) {
  return valuePaths(data).filter((p) => p[0] === "blocks" && data.blocks[p[1]]?.type !== "raw"
    && fieldAt(state.pageFields, data, p)?.widget === "image");
}

let drawing = 0;
async function draw() {
  const ticket = ++drawing;
  if (previewing) { previewing = null; $("history-bar").hidden = true; } // any change ends looking at an old version
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
    // The editor always lives at <site>/edit/, so the sub-folder the site is
    // really served from is the editor's own folder, one level up.
    const baseurl = new URL(SITE_ROOT).pathname.replace(/\/$/, "");
    state.render = makeRenderer({ Liquid, Marked, YAML, files: state.files, baseurl });
    state.current = "";
    listPages();
    $("site-select").replaceChildren(new Option("Site-wide…", ""), ...state.dataFiles.map((d) => new Option(d.label, d.file)));
    $("site-select").hidden = !state.dataFiles.length;
    show("workspace");
    await offerDraft();
    await goTo(state.pages[0].path);
    changed();
    // First time on this computer: the four things worth knowing.
    let welcomed = false;
    try { welcomed = !!localStorage.getItem("site-editor.welcomed"); localStorage.setItem("site-editor.welcomed", "1"); } catch {}
    if (!welcomed) openHelp(true);
    else say("Click any words or pictures on the page to change them.");
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
  if (state.config.site_url) document.title = `Edit ${new URL(state.config.site_url).hostname}`;

  $("page-select").onchange = (e) => {
    if (e.target.value === "__new") { e.target.value = state.current; openNewPage(); }
    else goTo(e.target.value);
  };
  $("site-select").onchange = (e) => { if (e.target.value) openDataFile(e.target.value); e.target.value = ""; };
  $("page-settings").onclick = () => select("page");
  $("panel-form").onmouseover = $("panel-form").onmouseleave = linkFromPanel;
  $("add-section").onclick = () => openPicker(typeof state.selected === "number" ? state.selected : null);
  $("picker-close").onclick = () => $("picker").close();
  $("newpage-form").addEventListener("submit", createPage);
  $("newpage-cancel").onclick = () => $("newpage").close();
  $("confirm-no").onclick = () => $("confirm").close();
  $("panel-close").onclick = () => select(null);
  $("panel-form").addEventListener("submit", (e) => e.preventDefault()); // Enter in a box must not reload
  // Keep the Google preview in step with what's typed.
  $("panel-form").addEventListener("input", () => $("panel-form").querySelector(".google")?.dispatchEvent(new Event("ed-refresh")));
  $("publish-btn").onclick = startPublish;
  $("history-btn").onclick = openHistory;
  $("help-btn").onclick = () => openHelp();
  $("history-restore").onclick = restoreVersion;
  $("history-back").onclick = endPreview;
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
