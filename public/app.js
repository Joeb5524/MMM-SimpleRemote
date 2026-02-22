(function () {
    const base = window.location.pathname.split("/").slice(0, 3).join("/");
    window.SR_BASE = base;

    window.srFetch = async function (path, opts) {
        const res = await fetch(`${window.SR_BASE}${path}`, Object.assign({
            headers: { "Content-Type": "application/json" },
            credentials: "include"
        }, opts || {}));

        if (res.status === 401) {
            window.location.href = `${window.SR_BASE}/login`;
            return null;
        }

        const text = await res.text();
        try { return { ok: res.ok, status: res.status, json: JSON.parse(text) }; }
        catch (_) { return { ok: res.ok, status: res.status, json: null, raw: text }; }
    };
})();