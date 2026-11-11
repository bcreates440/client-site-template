# client-site-template

Starting point for a new client website: Jekyll, hosted on Cloudflare
(Workers static assets, built from this repo on every push) + a click-to-edit
website editor at `/edit/` (with [Sveltia CMS](https://github.com/sveltia/sveltia-cms)
at `/admin/` as the advanced editor), both
signed in through a per-client Cloudflare Worker (code to copy:
`ops/templates/cms-auth-worker.js`). Not GitHub Pages: it isn't allowed to be
used as hosting for a paid service (see `ops/design/hosting-decision.md`).
Proven plumbing (layouts, the section-block system, `check.rb`) carried over
from a live site; the content is placeholder text for you to replace.

## Spin up a new client site

0. Provision the client's own Cloudflare Worker for CMS login — see
   `ops/templates/onboarding.md`, "CMS Auth Setup". Do this before the
   steps below; you'll need the worker URL for step 2.
1. Click **Use this template** (top of this repo's GitHub page) → create a
   new repository for the client.
2. In the new repo, edit `admin/config.yml`:
   - `backend.repo`: set to `<owner>/<new-repo-name>`
   - `backend.base_url`: the client's own `<slug>-cms-auth` worker URL from
     step 0 — not the shared worker
   - `site_url` / `display_url`: the client's real domain (or the
     `<repo>.bcreates440.workers.dev` URL for now)
3. Edit `_config.yml`: set `url`, `title`, `description`. Edit
   `wrangler.toml`: set `name` to the repo name. Update the `example.com`
   addresses in `sitemap.xml` and `robots.txt`. Sitemap entries and links are
   extensionless (`/contact`, not `/contact.html`), because the host serves
   pages that way. `check.rb` expects it.
4. Edit `_data/site.yml`: the real org name, contact info, socials, and
   `theme_color` (match it to `--brand` — a `<meta>` tag can't read a CSS
   variable, so it's the one colour stated twice).
5. Edit `_data/nav.yml` and add pages under `_content/` as needed — copy
   `_content/index.html` as a starting pattern, keep `slug`/`permalink`
   matching the file name.
6. Replace `images/logo.png` with the client's real logo (same file name,
   or update the references in `_includes/header.html`,
   `_includes/footer.html` and `admin/config.yml`'s `logo_url`).
7. Run `ruby check.rb` — must say `ALL CHECKS PASSED` before you push.
8. `git push`. Then in the Cloudflare dashboard: **Workers & Pages → Create →
   Import a repository**, pick the new repo, and set the build command to
   `bundle install && bundle exec jekyll build` (leave the deploy command
   as `npx wrangler deploy`). Under that Worker's **Settings → Build →
   Variables and secrets**, add `LANG` = `C.UTF-8` and `LC_ALL` = `C.UTF-8`.
   Without them the build fails on a Sass "Invalid US-ASCII character" error.
   Every push to `main` now publishes. **Do not
   enable GitHub Pages** — it isn't allowed to be used as hosting for a paid
   service. Then add the site's `https://<repo>.bcreates440.workers.dev`
   origin (and later its real domain) to the client's auth worker's
   `ALLOWED_ORIGINS`, or editor sign-in hangs.
9. Add the client as a collaborator (**Settings → Collaborators → Add
   people**, **Write** access, not Admin) once they have a GitHub account
   with a verified email.
10. Open `/edit/`, sign in with GitHub, change one word, Publish, and confirm
    it shows on the live site a minute later. (Both editors share the sign-in.)

## What's already wired up

- **The website editor (`edit/`)** — clients click the real page to change it.
  It reads `admin/config.yml` for every section and field, so it needs no
  per-client setup. Before giving it to a client, prove it draws this site
  exactly like Jekyll does (both must say they passed):
  `bundle exec jekyll build -d /tmp/built && node ../ops/tools/editor-parity/parity.mjs . edit/render.js /tmp/built`
  and `node ../ops/tools/editor-parity/coverage.mjs .`
  Site-only extras (e.g. a thumbnail folder, named link words) go in
  `edit/settings.yml` — see montaire-rally-demo's for an example.

- **Login** — `admin/config.yml`'s `backend.base_url` needs pointing at
  this client's own `<slug>-cms-auth` Cloudflare Worker (step 0 above) —
  each client gets an isolated worker so one broken worker can't take down
  every client's editor at once.
- **Block system** — `_layouts/page.html` renders a page from a list of
  typed sections (hero, prose, cards, split, table, gallery, strip,
  carousel, people, stats, cta, raw). See `_includes/blocks/` for each
  one's fields, and `_content/index.html` for a worked example.
- **`check.rb`** — walks `admin/config.yml`'s own field list, so it stays
  correct as you add fields — just remember to add new fields to
  `admin/config.yml` too, or the editor will silently delete them on save
  (see the comment at the top of that file).
- **`[[shortcuts]]`** — typing `[[org]]`, `[[phone]]`, `[[email]]`,
  `[[address]]` in body text pulls the value from `_data/site.yml`. Add
  more in `_includes/md.html` as a client's site needs them.

## What still needs a per-client decision

- The colour palette in `css/styles.css`'s `:root` block (`--navy`,
  `--red`, `--gold`, fonts) — a placeholder scheme, not any client's real
  brand.
- The hero image (`.hero` in `css/styles.css` — currently a plain colour;
  add the `url(...)` back in once there's a real photo).
- Whether this client needs more block types, more pages, or fields this
  template doesn't have yet — add them the same way the original site did:
  new `_includes/blocks/*.html` + a matching entry in `admin/config.yml`.

## Changing the typography

`--display` (headings + wordmark) and `--ui` (buttons, eyebrows, table
headers) are separate tokens on purpose: keep `--ui` a sans even when
`--display` is a serif, because uppercase serif at label size reads dated.
`--display-case` switches headings between `uppercase` and sentence case, and
`--display-weight` compensates when a lighter face replaces the heavy default.

To self-host a heading font (no third-party request, client owns the file):

1. Put the `.woff2` in `fonts/` along with its licence (use an OFL face).
2. Add an `@font-face` above `:root` in `css/styles.css`, with
   `font-display:swap`. The `src:` path is `../fonts/...` — stylesheet paths
   resolve from the stylesheet, not the page.
3. Preload it in `_includes/head.html`, before the stylesheet link:
   `<link rel="preload" href="fonts/NAME.woff2" as="font" type="font/woff2" crossorigin>`
   (`crossorigin` is required even same-origin, or the font downloads twice.)
4. Point `--display` at it, with real fallbacks after it.

`bcreates440/jones-uncommon-site` is a worked example of all four steps.

## Local preview

```
bundle exec jekyll serve
# then open http://localhost:4000
```
