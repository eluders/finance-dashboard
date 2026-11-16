// Minimal GitHub client for a private data repo.
// Reads are pinned to a commit SHA (no stale-cache surprises); writes are atomic
// multi-file commits via the Git Data API with optimistic-concurrency retry.

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(`GitHub ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

export class GitHubRepo {
  constructor({ owner, repo, branch = "main", token }) {
    if (!owner || !repo || !token) throw new Error("GitHub owner, repo and token are required (see Options).");
    Object.assign(this, { owner, repo, branch, token });
  }

  async req(path, { method = "GET", body, accept = "application/vnd.github+json" } = {}) {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) {
      let msg = res.statusText, data = null;
      try { data = await res.json(); msg = data.message || msg; } catch (_) {}
      // GitHub answers 404 (not 403) when a token can't see a private repo
      if (res.status === 401) msg += " (token invalid or expired: create a new one in Options)";
      else if (res.status === 403 || (res.status === 404 && (method !== "GET" || path === "")))
        msg += ` (check that the token has access to ${this.owner}/${this.repo} with "Contents: Read and write")`;
      throw new GitHubError(res.status, msg, data);
    }
    return accept.includes("raw") ? res.text() : res.status === 204 ? null : res.json();
  }

  async repoInfo() {
    return this.req("");
  }

  /** SHA of the branch head, or null if the repo is empty. */
  async headSha() {
    try {
      const ref = await this.req(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
      return ref.object.sha;
    } catch (e) {
      if (e.status === 404 || e.status === 409) return null;
      throw e;
    }
  }

  /** Raw file text at a given ref, or null if missing. */
  async readText(path, ref) {
    const p = path.split("/").map(encodeURIComponent).join("/");
    try {
      return await this.req(`/contents/${p}?ref=${encodeURIComponent(ref || this.branch)}`, { accept: "application/vnd.github.raw+json" });
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async readJSON(path, ref, fallback = null) {
    const t = await this.readText(path, ref);
    return t == null ? fallback : JSON.parse(t);
  }

  /** Lists a directory (names + types) at ref; [] if missing. */
  async listDir(path, ref) {
    const p = path.split("/").map(encodeURIComponent).join("/");
    try {
      const items = await this.req(`/contents/${p}?ref=${encodeURIComponent(ref || this.branch)}`);
      return Array.isArray(items) ? items.map((i) => ({ name: i.name, path: i.path, type: i.type })) : [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  /** Creates the first commit in an empty repo (Git Data API doesn't work on empty repos). */
  async initEmptyRepo(readme) {
    const b64 = btoa(unescape(encodeURIComponent(readme)));
    await this.req(`/contents/README.md`, { method: "PUT", body: { message: "Initialize finance data repo", content: b64, branch: this.branch } });
  }

  /**
   * Read-modify-write transaction producing one commit.
   * fn(read) receives read(path, fallback) bound to a consistent snapshot and returns
   * { files: [{path, content: string|object|null}], message } — content null deletes the file.
   * Retries if the branch moved underneath us.
   */
  async transact(fn, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const head = await this.headSha();
      if (!head) throw new Error("Data repo is empty — run 'Initialize data repo' in Options.");
      const read = (path, fallback = null) => this.readJSON(path, head, fallback);
      const readText = (path) => this.readText(path, head);
      const result = await fn(read, readText);
      if (!result || !result.files || !result.files.length) return { committed: false, result };
      const commit = await this.req(`/git/commits/${head}`);
      const tree = await this.req(`/git/trees`, {
        method: "POST",
        body: {
          base_tree: commit.tree.sha,
          tree: result.files.map((f) => f.content === null
            ? { path: f.path, mode: "100644", type: "blob", sha: null }
            : { path: f.path, mode: "100644", type: "blob", content: typeof f.content === "string" ? f.content : JSON.stringify(f.content, null, 2) + "\n" }),
        },
      });
      const newCommit = await this.req(`/git/commits`, { method: "POST", body: { message: result.message, tree: tree.sha, parents: [head] } });
      try {
        await this.req(`/git/refs/heads/${encodeURIComponent(this.branch)}`, { method: "PATCH", body: { sha: newCommit.sha, force: false } });
        return { committed: true, sha: newCommit.sha, result };
      } catch (e) {
        if (e.status === 422 && attempt < retries) continue; // not a fast-forward: someone else committed; redo
        throw e;
      }
    }
  }
}
