# client-site-template

Starting point for a new client website: Jekyll + GitHub Pages + a [Decap
CMS](https://decapcms.org/) editor at `/admin/`, signed in through the
shared [client-sites-auth](https://github.com/bcreates440/client-sites-auth)
worker. Proven plumbing (layouts, the section-block system, `check.rb`)
carried over from a live site; the content is placeholder text for you to
replace.

## Spin up a new client site

1. Click **Use this template** (top of this repo's GitHub page) → create a
   new repository for the client.
2. In the new repo, edit `admin/config.yml`:
   - `backend.repo`: set to `<owner>/<new-repo-name>`
   - `site_url` / `display_url`: the client's real domain (or the
     `github.io` URL for now)
3. Edit `_config.yml`: set `url`, `title`, `description`.
4. Edit `_data/site.yml`: the real org name, contact info, socials.
5. Edit `_data/nav.yml` and add pages under `_content/` as needed — copy
   `_content/index.html` as a starting pattern, keep `slug`/`permalink`
   matching the file name.
6. Replace `images/logo.png` with the client's real logo (same file name,
   or update the references in `_includes/header.html`,
   `_includes/footer.html` and `admin/config.yml`'s `logo_url`).
7. Run `ruby check.rb` — must say `ALL CHECKS PASSED` before you push.
8. `git push`, then enable GitHub Pages in the new repo's Settings.
9. Add the client as a collaborator (**Settings → Collaborators → Add
   people**, **Write** access, not Admin) once they have a GitHub account
   with a verified email.
10. Open `/admin/`, sign in with GitHub, confirm a test save round-trips.

## What's already wired up

- **Login** — `admin/config.yml` already points at the shared OAuth worker.
  No per-client Cloudflare/GitHub OAuth App setup needed.
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

## Local preview

```
bundle exec jekyll serve
# then open http://localhost:4000
```
