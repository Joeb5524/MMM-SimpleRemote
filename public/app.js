(function () {
    const p = window.location.pathname;


    function getBasePath(pathname) {
        const publicIdx = pathname.indexOf("/public/");
        if (publicIdx !== -1) {
            return pathname.slice(0, publicIdx);
        }

        const parts = pathname.split("/").filter(Boolean);
        if (parts.length === 0) return "";

        const last = parts[parts.length - 1];
        if (last === "login" || last === "dashboard" || last === "config") {
            return "/" + parts.slice(0, -1).join("/");
        }


        return "/" + parts[0];
    }

    window.SR_BASE = getBasePath(p);

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