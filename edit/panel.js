// The settings panel: a form for one section (or the page), built from that
// section type's fields in admin/config.yml, so a new field added there
// shows up here with no editor change.

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
};
let uid = 0;
const plain = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();

// The field definition for one value in the page, or null.
export function fieldAt(pageFields, data, path) {
  if (path[0] !== "blocks") return pageFields.find((f) => f.name === path[0]) ?? null;
  const blocks = pageFields.find((f) => f.name === "blocks");
  const type = blocks.types.find((t) => t.name === data.blocks[path[1]]?.type);
  if (!type) return null;
  let def = { widget: "object", fields: type.fields };
  for (const p of path.slice(2)) {
    if (typeof p === "number") {
      if (def.widget !== "list") return null;
      def = def.fields ? { widget: "object", fields: def.fields } : def.field ?? { widget: "string", label: def.label };
    } else {
      def = def.fields?.find((f) => f.name === p) ?? null;
      if (!def) return null;
    }
  }
  return def;
}

export function blockType(pageFields, type) {
  return pageFields.find((f) => f.name === "blocks").types.find((t) => t.name === type);
}

function summary(def, item) {
  if (def.summary && item && typeof item === "object") {
    const s = plain(def.summary.replace(/\{\{fields\.(\w+)\}\}/g, (_, k) => plain(item[k])));
    if (s.replace(/[\s\-·]/g, "")) return s;
  }
  if (typeof item === "string") return plain(item) || "(empty)";
  const first = item && Object.values(item).find((v) => typeof v === "string" && v);
  return plain(first) || "(empty)";
}

// A blank item for "Add": every field present, so nothing is left undefined.
export function blank(def) {
  if (!def.fields && !def.field) return "";
  if (def.field) return blankValue(def.field);
  return Object.fromEntries(def.fields.filter((f) => f.required !== false || f.default !== undefined).map((f) => [f.name, blankValue(f)]));
}
function blankValue(f) {
  if (f.default !== undefined) return f.default;
  if (f.widget === "list") return [];
  if (f.widget === "boolean") return false;
  if (f.widget === "number") return 0;
  if (f.widget === "object") return blank(f);
  return "";
}

/**
 * Draws a form into `root`.
 *   fields: the field list, value: the current data, path: where it lives
 *   ctx: { set(path, value), list(path, op, index), focusPath }
 */
export function drawForm(root, fields, value, path, ctx) {
  root.replaceChildren(...fields.filter((f) => f.widget !== "hidden").map((f) => field(f, value?.[f.name], [...path, f.name], ctx)));
}

function labelled(def, path, control, ctx) {
  const id = `f${++uid}`;
  control.id = id;
  control.dataset.path = JSON.stringify(path);
  const hint = def.hint ? h("p", { className: "hint", id: `${id}-hint` }, def.hint.trim()) : null;
  if (hint) control.setAttribute("aria-describedby", hint.id);
  return h("div", { className: "field" },
    h("label", { htmlFor: id }, def.label ?? def.name, def.required === false ? null : h("span", { className: "req", "aria-hidden": "true" }, " *")),
    control, hint);
}

// Short text is stored as a snippet of HTML (so "&" is saved as "&amp;").
// Show people the words, not the code - unless it holds real tags like <em>,
// which then have to stay visible to be kept.
const hasTags = (s) => /<[a-z/][^>]*>/i.test(s ?? "");
const toWords = (s) => { const t = document.createElement("textarea"); t.innerHTML = s ?? ""; return t.value; };
const toHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function field(def, value, path, ctx) {
  const set = (v) => ctx.set(path, v);
  const asWords = typeof value === "string" && !hasTags(value) && def.widget !== "markdown";
  const shown = asWords ? toWords(value) : value ?? "";
  const setText = (v) => set(asWords ? toHtml(v) : v);
  switch (def.widget) {
    case "text":
    case "markdown":
      return labelled(def, path, h("textarea", { rows: def.widget === "markdown" ? 6 : 3, value: shown, oninput: (e) => setText(e.target.value) }), ctx);
    case "number":
      return labelled(def, path, h("input", { type: "number", value: value ?? "", oninput: (e) => set(e.target.value === "" ? null : Number(e.target.value)) }), ctx);
    case "boolean": {
      const id = `f${++uid}`;
      return h("div", { className: "field check" },
        h("input", { type: "checkbox", id, checked: !!value, "data-path": JSON.stringify(path), onchange: (e) => set(e.target.checked) }),
        h("label", { htmlFor: id }, def.label ?? def.name),
        def.hint ? h("p", { className: "hint" }, def.hint.trim()) : null);
    }
    case "select": {
      const opts = (def.options ?? []).map((o) => (typeof o === "object" ? o : { label: o === "" ? "(none)" : o, value: o }));
      const sel = h("select", { onchange: (e) => set(e.target.value) }, opts.map((o) => new Option(o.label, o.value)));
      sel.value = value ?? "";
      return labelled(def, path, sel, ctx);
    }
    case "object":
      return h("fieldset", { className: "group" }, h("legend", {}, def.label ?? def.name),
        h("div", {}, ...(def.fields ?? []).map((f) => field(f, value?.[f.name], [...path, f.name], ctx))));
    case "list":
      return list(def, Array.isArray(value) ? value : [], path, ctx);
    case "image":
    case "file":
      return labelled(def, path, h("input", { type: "text", value: value ?? "", oninput: (e) => set(e.target.value) }), ctx);
    default: // string and anything unknown: a plain text box
      return labelled(def, path, h("input", { type: "text", value: shown, oninput: (e) => setText(e.target.value) }), ctx);
  }
}

function list(def, items, path, ctx) {
  const itemDef = def.fields ? { widget: "object", fields: def.fields } : def.field ?? { widget: "string", label: def.label_singular ?? "Item" };
  const name = (def.label_singular ?? def.label ?? "item").toLowerCase().replace(/s$/, "");
  const rows = items.map((item, i) => {
    const p = [...path, i];
    const tools = h("div", { className: "item-tools" },
      h("button", { type: "button", disabled: i === 0, onclick: () => ctx.list(path, "up", i) }, "Move up"),
      h("button", { type: "button", disabled: i === items.length - 1, onclick: () => ctx.list(path, "down", i) }, "Move down"),
      h("button", { type: "button", onclick: () => ctx.list(path, "copy", i) }, "Duplicate"),
      h("button", { type: "button", className: "danger", onclick: () => ctx.list(path, "remove", i) }, "Remove"));
    if (itemDef.widget !== "object") {
      return h("div", { className: "item simple" }, field({ ...itemDef, label: `${def.label_singular ?? "Item"} ${i + 1}` }, item, p, ctx), tools);
    }
    const open = ctx.focusPath && JSON.stringify(ctx.focusPath.slice(0, p.length)) === JSON.stringify(p);
    return h("details", { className: "item", open },
      h("summary", {}, summary(def, item)),
      h("div", { className: "item-body" }, ...itemDef.fields.map((f) => field(f, item?.[f.name], [...p, f.name], ctx)), tools));
  });
  return h("fieldset", { className: "group list" },
    h("legend", {}, def.label ?? def.name),
    ...rows,
    h("button", { type: "button", className: "add", onclick: () => ctx.list(path, "add", items.length, blank(def)) }, `+ Add ${name}`));
}
