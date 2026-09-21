# ---------------------------------------------------------------------------
#  Site check.   Run it before you publish:   ruby check.rb
#
#  The most important thing it catches is this: the website editor rewrites a
#  page from the field list in admin/config.yml. If a page contains a setting
#  that config.yml does not describe, saving that page in the editor SILENTLY
#  DELETES the setting. This script finds those before an editor does.
#
#  It also checks the ordinary things that quietly break a static site.
# ---------------------------------------------------------------------------
require "yaml"
require "date"
require "set"

Dir.chdir(__dir__)
$fail = 0
def bad(msg) = ($fail += 1; puts "FAIL: #{msg}")
def ok(msg)  = puts("ok:   #{msg}")

PAGES = Dir["_content/*.html"].sort
SITE  = "_site"

# --- load ------------------------------------------------------------------
def front_matter(path)
  raw = File.read(path, encoding: "utf-8")
  m = raw.match(/\A---\s*\n(.*?)\n---\s*\n?/m) or return nil
  YAML.load(m[1], aliases: true, permitted_classes: [Date])
end

cfg = YAML.load_file("admin/config.yml", aliases: true)
pages_coll = cfg["collections"].find { |c| c["name"] == "pages" }
page_fields = pages_coll["fields"]
blocks_field = page_fields.find { |f| f["name"] == "blocks" }
block_types = blocks_field["types"].to_h { |t| [t["name"], t["fields"]] }

# --- 1. every field in every page is described in admin/config.yml ---------
def check_obj(data, fields, where, missing)
  return unless data.is_a?(Hash)
  by_name = (fields || []).to_h { |f| [f["name"], f] }
  data.each do |key, value|
    f = by_name[key]
    if f.nil?
      missing << "#{where}.#{key}"
      next
    end
    case f["widget"]
    when "list"
      next unless value.is_a?(Array)
      if f["fields"]
        value.each_with_index { |item, i| check_obj(item, f["fields"], "#{where}.#{key}[#{i}]", missing) }
      end
    when "object"
      check_obj(value, f["fields"], "#{where}.#{key}", missing)
    end
  end
end

missing = []
PAGES.each do |p|
  fm = front_matter(p) or next bad("#{p} has no front matter")
  slug = File.basename(p, ".html")
  top = fm.reject { |k, _| k == "blocks" }
  check_obj(top, page_fields, slug, missing)
  (fm["blocks"] || []).each_with_index do |b, i|
    type = b["type"]
    fields = block_types[type]
    next missing << "#{slug}.blocks[#{i}] unknown section type '#{type}'" if fields.nil?
    check_obj(b.reject { |k, _| k == "type" }, fields, "#{slug}.blocks[#{i}](#{type})", missing)
  end
end
if missing.empty?
  ok "admin/config.yml describes every field used in all #{PAGES.size} pages"
else
  missing.each { |m| bad "not in admin/config.yml, the editor would delete it: #{m}" }
end

# --- 2. the data files the editor writes still match what the site reads ---
{ "_data/site.yml" => "site", "_data/team.yml" => "team", "_data/nav.yml" => "nav" }.each do |file, name|
  data = YAML.load_file(file, aliases: true, permitted_classes: [Date])
  bad("#{file} must be a set of named settings, not a bare list") unless data.is_a?(Hash)
  coll = cfg["collections"].find { |c| c["name"] == "settings" }
  entry = coll["files"].find { |f| f["file"] == file }
  next bad("#{file} is not editable - no entry for it in admin/config.yml") if entry.nil?
  m = []
  check_obj(data, entry["fields"], name, m)
  m.each { |x| bad "not in admin/config.yml, the editor would delete it: #{x}" }
  ok "#{file} fully described in admin/config.yml" if m.empty?
end

# --- 3. built output ------------------------------------------------------
if Dir.exist?(SITE)
  built = Dir["#{SITE}/*.html"].reject { |f| f.include?("admin") }

  left = built.flat_map { |f| File.read(f, encoding: "utf-8").scan(/\[\[[a-z_]+\]\]/) }.uniq
  left.empty? ? ok("no unfilled [[shortcuts]] left in the built pages") :
                bad("unfilled shortcuts in the built pages: #{left.join(', ')} - check the spelling against _includes/md.html")

  imgs = Set.new
  built.each { |f| File.read(f, encoding: "utf-8").scan(/(?:src="|url\(")(images\/[^"]+)/) { imgs << $1 } }
  gone = imgs.reject { |i| File.exist?(i) }
  gone.empty? ? ok("all #{imgs.size} referenced images exist") : gone.each { |i| bad "missing image #{i}" }

  links = Set.new
  built.each { |f| File.read(f, encoding: "utf-8").scan(/href="([a-z0-9_-]+\.html)(?:#[^"]*)?"/) { links << $1 } }
  dead = links.reject { |l| File.exist?(File.join(SITE, l)) }
  dead.empty? ? ok("all #{links.size} internal links resolve") : dead.each { |l| bad "link to a page that does not exist: #{l}" }

  built.each do |f|
    n = File.read(f, encoding: "utf-8").scan(/<h1[ >]/).size
    bad "#{File.basename(f)} has #{n} <h1> headings - it must have exactly 1" unless n == 1
  end
  ok "every page has exactly one <h1>" if $fail == 0 || built.all? { |f| File.read(f, encoding: "utf-8").scan(/<h1[ >]/).size == 1 }

  %w[title description].each do |what|
    re = what == "title" ? /<title>(.*?)<\/title>/ : /<meta name="description" content="(.*?)">/
    seen = {}
    built.each do |f|
      v = File.read(f, encoding: "utf-8")[re, 1]
      seen[v] ? bad("#{File.basename(f)} has the same #{what} as #{seen[v]}") : seen[v] = File.basename(f)
    end
  end
  ok "every page has its own title and description" if $fail == 0

  if File.exist?("sitemap.xml")
    xml = File.read("sitemap.xml", encoding: "utf-8")
    built.each do |f|
      name = File.basename(f)
      bad "#{name} is not listed in sitemap.xml" unless xml.include?(name)
    end
  end
else
  puts "note: no _site folder - run 'bundle exec jekyll build' first to check the built pages"
end

# --- 4. no hardcoded colours outside the token block ----------------------
#  A colour written anywhere except :root is a colour that will NOT follow the
#  brand when this site is rebranded. That is how a site ends up with stray
#  navy text on a green palette. This check keeps the "change the tokens,
#  rebrand the site" promise honest.
#
#  _data/*.yml is deliberately NOT scanned: theme_color lives there on purpose,
#  because a <meta> tag cannot read a CSS variable.
HEX = /(?<![\w&])#(?:\h{3}|\h{6}|\h{8})\b/

def neutral_rgb?(fn)
  nums = fn.scan(/\d+/).first(3).map(&:to_i)
  return false if nums.size < 3
  nums.all?(&:zero?) || nums.all? { |n| n == 255 }
end

if File.exist?("css/styles.css")
  css  = File.read("css/styles.css", encoding: "utf-8")
  root = css[/:root\s*\{.*?\n\}/m].to_s
  rest = css.sub(root, "")
  strays = rest.scan(HEX).uniq
  rgbs   = rest.scan(/rgba?\([^)]*\)/).reject { |r| r.include?("var(") || neutral_rgb?(r) }.uniq
  strays.each { |c| bad "hardcoded colour #{c} in css/styles.css outside :root - add a token in :root and use var()" }
  rgbs.each   { |r| bad "hardcoded colour #{r} in css/styles.css outside :root - add a token in :root and use var()" }
  ok "css/styles.css: every colour comes from a :root token" if strays.empty? && rgbs.empty?
end

tmpl_bad = 0
(Dir["_includes/**/*.html"] + Dir["_layouts/*.html"] + Dir["_content/*.html"]).sort.each do |f|
  File.read(f, encoding: "utf-8").scan(HEX).uniq.each do |c|
    tmpl_bad += 1
    bad "hardcoded colour #{c} in #{f} - use a class in css/styles.css instead of an inline style"
  end
end
ok "no hardcoded colours in templates or page content" if tmpl_bad.zero?

# --- 5. every {% include %} target actually exists -------------------------
# Added 2026-09-20. _layouts/page.html called countdown.html for months; the
# file was never carried over from wwca-site when the template was
# generalized. Nothing caught it because no page set the flag that triggers
# it - but the moment one did, the build would die and the site would just
# stop updating.
includes = Set.new
(Dir["_layouts/*.html"] + Dir["_includes/**/*.html"] + Dir["_content/*.html"]).each do |f|
  File.read(f, encoding: "utf-8").scan(/\{%-?\s*include\s+([A-Za-z0-9_\/.-]+)/) { includes << $1 }
end
missing_inc = includes.reject { |i| File.exist?(File.join("_includes", i)) }.sort
if missing_inc.empty?
  ok "all #{includes.size} {% include %} targets exist"
else
  missing_inc.each { |i| bad "missing _includes/#{i} - any page reaching it fails the build" }
end

# --- 6. no :root token defined in terms of itself --------------------------
# Added 2026-09-20 after finding all nine derived tokens in
# client-site-template written as `--on-brand:var(--on-brand)`. That is a
# cycle, which CSS treats as invalid at computed-value time, so the token
# silently resolves to nothing. Check 4 above passes it, because the colour
# IS technically inside :root - it just never resolves.
root_css = File.read("css/styles.css", encoding: "utf-8")[/:root\s*\{(.*?)\}/m, 1].to_s
circular = root_css.scan(/--([a-z0-9-]+)\s*:\s*var\(\s*--([a-z0-9-]+)\s*\)/i)
                   .select { |name, ref| name.downcase == ref.downcase }.map(&:first).uniq
if circular.empty?
  ok "no :root token is defined in terms of itself"
else
  circular.each { |t| bad "--#{t} in :root is defined as var(--#{t}) - a cycle, so it resolves to nothing" }
end


puts ""
puts $fail.zero? ? "ALL CHECKS PASSED" : "#{$fail} problem(s) found"
exit($fail.zero? ? 0 : 1)
