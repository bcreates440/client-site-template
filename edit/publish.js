// Publishing: the checks that run first, and the one commit that puts every
// change live together.
//
// Everything goes up as ONE commit through GitHub's Git Data API (blobs ->
// tree -> commit -> move the branch), never forced. If the branch moved
// since the editor loaded it (someone saved in the backup editor, Blake
// pushed a fix, another tab published), the files that both sides changed
// are reported so the client can choose; files only one side touched are
// simply combined.

// ------------------------------------------------------------- checks ---
const empty = (v) => v == null || (typeof v === "string" && v.trim() === "");

/**
 * Problems in the files about to be published, in plain English.
 * pages: [{ path, title, data }] for changed pages
 * Returns [{ file, path, where, message }] - path is where to take the client.
 */
export function check(pages, pageFields, blockType) {
  const problems = [];
  for (const page of pages) {
    const blocks = page.data.blocks ?? [];
    for (const f of pageFields) {
      if (f.name === "blocks" || f.widget === "hidden") continue;
      if (f.required !== false && empty(page.data[f.name]) && !["boolean", "number", "list", "object"].includes(f.widget)) {
        problems.push({ file: page.path, path: [f.name], where: `${page.title} - Page settings`, message: `"${f.label ?? f.name}" is empty.` });
      }
    }
    blocks.forEach((b, i) => {
      const type = blockType(b.type);
      if (!type || b.type === "raw") return;
      walk(type.fields, b, ["blocks", i], `${page.title} - ${type.label}`, page.path, problems);
    });
  }
  return problems;
}

function walk(fields, value, path, where, file, problems) {
  for (const f of fields ?? []) {
    const v = value?.[f.name];
    const p = [...path, f.name];
    const label = f.label ?? f.name;
    if (f.widget === "object") { walk(f.fields, v, p, where, file, problems); continue; }
    if (f.widget === "list") {
      if (Array.isArray(v) && f.fields) v.forEach((item, i) => walk(f.fields, item, [...p, i], where, file, problems));
      continue;
    }
    if (["boolean", "number", "hidden", "select"].includes(f.widget)) continue;
    if (f.required !== false && empty(v)) {
      problems.push({ file, path: p, where, message: `"${label}" is empty.` });
      continue;
    }
    if (f.pattern && !empty(v) && !new RegExp(f.pattern[0]).test(String(v))) {
      problems.push({ file, path: p, where, message: `"${label}": ${f.pattern[1]}` });
    }
    // A picture needs words for people who can't see it.
    if (f.widget === "image" && !empty(v)) {
      const alt = [`${f.name}_alt`, "alt", "image_alt"].find((n) => fields.some((x) => x.name === n));
      if (alt && empty(value?.[alt])) {
        problems.push({ file, path: [...path, alt], where, message: "A picture has no description. Describe what it shows." });
      }
    }
  }
}

// ------------------------------------------------------------ sitemap ---
/**
 * Keeps a hand-written sitemap.xml in step with what's being published, so
 * Google hears about new pages and nobody has to remember to edit it.
 *   pages: [{ permalink, kind: "added" | "changed" | "deleted" }]
 *   siteUrl: _config.yml's url; today: "YYYY-MM-DD"
 *   extensionless: the host serves /contact for contact.html, so the
 *     sitemap lists addresses without ".html"
 * Pages are matched by address in any of those forms.
 */
export function updateSitemap(xml, pages, siteUrl, today, { extensionless = false } = {}) {
  // The sitemap's own home-page entry says what address the site really
  // lives at; _config.yml's url can lag behind a move.
  const home = xml.match(/<loc>(https?:\/\/[^<]*?)\/(?:index\.html)?<\/loc>/);
  const root = (home?.[1] ?? String(siteUrl ?? "")).replace(/\/$/, "");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bare = (p) => p.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  const forms = (p) => [...new Set([p, p.replace(/\/index\.html$/, "/"), p.replace(/\/$/, "/index.html"), bare(p)])].map((x) => root + x);
  const block = (loc) => new RegExp(`[ \\t]*<url>\\s*<loc>${esc(loc)}</loc>[\\s\\S]*?</url>\\n?`);
  const find = (p) => forms(p).find((loc) => block(loc).test(xml));
  for (const { permalink, kind } of pages) {
    if (!permalink) continue;
    const loc = find(permalink);
    if (kind === "deleted") { if (loc) xml = xml.replace(block(loc), ""); continue; }
    if (loc) {
      xml = xml.replace(block(loc), (b) => b.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${today}</lastmod>`));
    } else if (kind === "added") {
      const entry = `  <url><loc>${root}${extensionless ? bare(permalink) : permalink}</loc>\n       <lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n`;
      xml = xml.replace(/<\/urlset>/, `${entry}</urlset>`);
    }
  }
  return xml;
}

// ------------------------------------------------------------ publish ---
async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Conflict extends Error {
  constructor(files, head) { super("changed elsewhere"); this.files = files; this.head = head; }
}

/**
 * gh:      the editor's GitHub fetch helper (path, opts) -> json
 * changes: [[path, text|null]] - null deletes the file
 * uploads: { path: Blob }
 * base:    the commit the editor loaded
 * overwrite: true to replace files that were also changed elsewhere
 * Returns { sha, theirs }: the new commit, and the files changed elsewhere
 * that this publish was combined with. The editor must reload those -
 * otherwise its copies are out of date, and the next publish would quietly
 * put the old versions back.
 */
export async function publish({ gh, repo, branch, base, changes, uploads, message, overwrite = false, onStep = () => {} }) {
  const ref = `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  const theirs = new Set();
  for (let attempt = 0; attempt < 3; attempt++) {
    onStep("Checking for changes made elsewhere…");
    const head = (await gh(ref)).object.sha;
    if (head !== base) {
      const cmp = await gh(`/repos/${repo}/compare/${base}...${head}`);
      for (const f of cmp.files ?? []) theirs.add(f.filename);
      const both = changes.map(([p]) => p).filter((p) => theirs.has(p));
      if (both.length && !overwrite) throw new Conflict(both, head);
    }
    const headCommit = await gh(`/repos/${repo}/git/commits/${head}`);

    onStep("Sending your changes…");
    const tree = [];
    for (const [path, text] of changes) {
      if (text == null) { tree.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
      const blob = await gh(`/repos/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: text, encoding: "utf-8" }) });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const [path, file] of Object.entries(uploads)) {
      onStep("Sending your pictures…");
      const blob = await gh(`/repos/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: await toBase64(file), encoding: "base64" }) });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await gh(`/repos/${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
    const commit = await gh(`/repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }) });

    onStep("Publishing…");
    try {
      await gh(ref, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
      const ours = new Set(changes.map(([p]) => p));
      return { sha: commit.sha, theirs: [...theirs].filter((p) => !ours.has(p)) };
    } catch (err) {
      // Someone published in the last few seconds: start again on top of them.
      if (!/ 422 /.test(err.message)) throw err;
      base = head;
    }
  }
  throw new Error("The website is being changed somewhere else right now. Wait a minute and publish again.");
}
