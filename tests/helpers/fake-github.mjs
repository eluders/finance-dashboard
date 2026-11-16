// In-memory stand-in for the subset of the GitHub REST API that lib/github.js uses.
// Mirrors real behaviors that matter: empty repos 409 on refs, raw vs JSON contents,
// Git Data API trees/commits, and non-fast-forward ref updates returning 422.
export function fakeGitHub({ owner = "me", repo = "finance-data", isPrivate = true } = {}) {
  const trees = new Map(); // sha -> Map(path -> content)
  const commits = new Map(); // sha -> { tree, parent, message }
  let head = null;
  let n = 0;
  const sha = () => (++n).toString(16).padStart(40, "0");
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const filesAt = (ref) => {
    const c = ref === "main" ? head : ref;
    return c && commits.has(c) ? trees.get(commits.get(c).tree) : null;
  };

  async function fetch(url, opts = {}) {
    const u = new URL(url);
    if (!url.startsWith(base)) return json(404, { message: "Not Found" });
    const path = decodeURIComponent(u.pathname.slice(new URL(base).pathname.length));
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    const accept = opts.headers?.Accept || "";

    if (path === "" && method === "GET") return json(200, { full_name: `${owner}/${repo}`, private: isPrivate, permissions: { push: true } });
    if (path === "/git/ref/heads/main") return head ? json(200, { object: { sha: head } }) : json(409, { message: "Git Repository is empty." });

    if (path.startsWith("/contents/")) {
      const p = path.slice("/contents/".length);
      if (method === "PUT") {
        if (head) return json(422, { message: "sha required" });
        const t = sha(); trees.set(t, new Map([[p, Buffer.from(body.content, "base64").toString("utf8")]]));
        const c = sha(); commits.set(c, { tree: t, parent: null, message: body.message }); head = c;
        return json(201, { commit: { sha: c } });
      }
      const files = filesAt(u.searchParams.get("ref") || "main");
      if (!files) return json(404, { message: "This repository is empty." });
      if (files.has(p)) return accept.includes("raw") ? new Response(files.get(p), { status: 200 }) : json(200, { type: "file", path: p });
      const prefix = p ? p + "/" : "";
      const kids = new Map();
      for (const f of files.keys()) if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const name = rest.split("/")[0];
        kids.set(name, { name, path: prefix + name, type: rest.includes("/") ? "dir" : "file" });
      }
      return kids.size ? json(200, [...kids.values()]) : json(404, { message: "Not Found" });
    }
    let m;
    if ((m = path.match(/^\/git\/commits\/(\w+)$/))) return json(200, { sha: m[1], tree: { sha: commits.get(m[1]).tree } });
    if (path === "/git/trees" && method === "POST") {
      const t = new Map(trees.get(body.base_tree));
      for (const e of body.tree) e.sha === null ? t.delete(e.path) : t.set(e.path, e.content);
      const s = sha(); trees.set(s, t);
      return json(201, { sha: s });
    }
    if (path === "/git/commits" && method === "POST") {
      const s = sha(); commits.set(s, { tree: body.tree, parent: body.parents[0], message: body.message });
      return json(201, { sha: s });
    }
    if (path === "/git/refs/heads/main" && method === "PATCH") {
      if (commits.get(body.sha).parent !== head) return json(422, { message: "Update is not a fast forward" });
      head = body.sha;
      return json(200, { object: { sha: head } });
    }
    return json(404, { message: `fake: unhandled ${method} ${path}` });
  }

  return {
    fetch,
    files: () => filesAt("main") || new Map(),
    log: () => { const out = []; for (let c = head; c; c = commits.get(c).parent) out.push(commits.get(c).message); return out; },
  };
}
