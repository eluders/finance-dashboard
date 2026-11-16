// Category taxonomy: ordered groups, each with ordered categories.
//   categories.json v2: { version: 2, groups: [{ id, name, side?, color?, sectionBreak?, categories: [{ id, name }] }] }
//   side: "minimize" (default; spending) or "maximize" (income, giving, saving, investing). Categories take their group's side.
// Category ids are stable (renames don't touch transactions). v1 (flat list with `group`) is migrated on read.
//
// Built-in "Archive" (id "archive"): not part of the user's groups. Archived transactions are hidden
// from the summary and from the transaction list unless the list is filtered to Archive.
export const ARCHIVE_ID = "archive";
export const ARCHIVE = { id: ARCHIVE_ID, name: "Archive", groupId: ARCHIVE_ID, groupName: "Archive" };

export const SIDES = ["minimize", "maximize"];
export const sideOf = (g) => (g?.side === "maximize" ? "maximize" : "minimize");

export function normalizeCategories(doc) {
  if (doc?.version === 2 && Array.isArray(doc.groups)) return doc;
  const groups = [];
  const byName = new Map();
  for (const c of doc?.categories || []) {
    const gname = c.group || "Other";
    if (!byName.has(gname)) {
      const g = { id: uniqueId(gname, groups.map((x) => x.id)), name: gname, categories: [] };
      byName.set(gname, g);
      groups.push(g);
    }
    byName.get(gname).categories.push({ id: c.id, name: c.name });
  }
  return { version: 2, groups };
}

/** id -> { id, name, groupId, groupName } */
export function categoryIndex(doc) {
  const m = new Map();
  for (const g of doc?.groups || []) for (const c of g.categories) m.set(c.id, { ...c, groupId: g.id, groupName: g.name, side: sideOf(g) });
  m.set(ARCHIVE_ID, ARCHIVE);
  return m;
}

export function uniqueId(name, taken) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "cat";
  const set = new Set(taken);
  let id = base, i = 2;
  while (set.has(id)) id = `${base}_${i++}`;
  return id;
}

/** Throws if the taxonomy is malformed (duplicate ids, blank names). */
export function validateCategories(doc) {
  if (doc?.version !== 2 || !Array.isArray(doc.groups)) throw new Error("Bad categories document.");
  const ids = new Set();
  for (const g of doc.groups) {
    if (!g.name?.trim()) throw new Error("Every group needs a name.");
    if (g.color != null && !/^#[0-9a-f]{6}$/i.test(g.color)) throw new Error(`Group "${g.name}" has a bad color "${g.color}".`);
    if (g.side != null && !SIDES.includes(g.side)) throw new Error(`Group "${g.name}" has an unknown side "${g.side}".`);
    for (const c of g.categories) {
      if (!c.name?.trim()) throw new Error(`A category in "${g.name}" has no name.`);
      if (ids.has(c.id)) throw new Error(`Duplicate category id ${c.id}.`);
      if (c.id === ARCHIVE_ID) throw new Error(`"${c.name}" uses the id reserved for the built-in Archive.`);
      ids.add(c.id);
    }
  }
  return doc;
}
