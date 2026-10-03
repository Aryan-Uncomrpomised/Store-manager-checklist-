// Small client for the Dispatch SOP server API (same origin, cookie session).
(function () {
  "use strict";
  async function call(method, path, body, headers) {
    const opts = { method, credentials: "same-origin", headers: headers || {} };
    if (body !== undefined) {
      if (body instanceof Blob) opts.body = body;
      else { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    }
    const r = await fetch(path, opts);
    if (r.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
    let data = null;
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw new Error((data && (data.error || data.code)) || "Request failed (" + r.status + ")");
    return data;
  }
  const enc = encodeURIComponent;
  window.SOP = {
    me: () => call("GET", "/api/me"),
    logout: () => call("POST", "/api/logout").finally(() => { location.href = "/login"; }),
    // Collections: daylog, stock, products, videos
    list: async (col) => (await call("GET", "/api/col/" + col)).map((x) => Object.assign({ id: x.id }, x.data)),
    get: async (col, id) => { const r = await call("GET", "/api/doc/" + col + "/" + enc(id)); return r.exists ? r.data : null; },
    put: (col, id, data) => call("PUT", "/api/doc/" + col + "/" + enc(id), data),
    del: (col, id) => call("DELETE", "/api/doc/" + col + "/" + enc(id)),
    upload: (file) => call("POST", "/api/upload", file, { "Content-Type": file.type }),
    deleteBlob: (id) => call("DELETE", "/api/blob/" + id),
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
  };
})();
