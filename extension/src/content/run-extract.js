// Last file injected for extraction; its final expression is returned to the popup.
(() => {
  const FD = globalThis.FD;
  const loc = window.location;
  const ex = FD.extractors
    .filter((e) => e.matches(loc))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
  try {
    const r = ex.extract();
    return {
      ok: true,
      extractorId: ex.id,
      institution: ex.institution,
      url: loc.origin + loc.pathname,
      title: document.title,
      extractedAt: new Date().toISOString(),
      ...r,
    };
  } catch (e) {
    return { ok: false, extractorId: ex && ex.id, url: loc.origin + loc.pathname, error: String(e && e.stack || e) };
  }
})();
