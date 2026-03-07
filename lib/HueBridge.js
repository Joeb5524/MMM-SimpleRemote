const https = require("https");
const EventEmitter = require("events");

class HueBridge extends EventEmitter {
    constructor(cfg = {}) {
        super();

        this.cfg = {
            enabled: false,
            apiVersion: "auto", // auto|v2|v1
            bridgeIp: "",
            hueApplicationKey: "",
            userId: "",
            insecureSkipVerify: true,
            pollIntervalMs: 15000,
            enableEventStream: true,
            minWriteIntervalMs: 120,
            refreshDebounceMs: 500,
            ...cfg
        };

        this._agent = new https.Agent({ rejectUnauthorized: !this.cfg.insecureSkipVerify });
        this._writer = new RateLimiter(this.cfg.minWriteIntervalMs);

        this._cache = new Map();
        this._cache.set("light", { items: [], ts: 0 });
        this._cache.set("grouped_light", { items: [], ts: 0 });

        this._pollTimer = null;


        this._streamReq = null;
        this._streamBackoff = 1000;
        this._reconnectTimer = null;
        this._refreshDebounce = null;
    }

    configure(partial = {}) {
        this.cfg = { ...this.cfg, ...(partial || {}) };
        this._agent = new https.Agent({ rejectUnauthorized: !this.cfg.insecureSkipVerify });
        this._writer.setMin(this.cfg.minWriteIntervalMs);

        this.stop();
        this.start();
    }

    effectiveApi() {
        const v = String(this.cfg.apiVersion || "auto").toLowerCase();
        if (v === "v2" || v === "2") return "v2";
        if (v === "v1" || v === "1") return "v1";
        return this.cfg.hueApplicationKey ? "v2" : "v1";
    }

    isConfigured() {
        if (!this.cfg.enabled) return false;
        if (!this.cfg.bridgeIp) return false;
        const api = this.effectiveApi();
        return api === "v2" ? !!this.cfg.hueApplicationKey : !!this.cfg.userId;
    }

    status() {
        return {
            enabled: !!this.cfg.enabled,
            configured: this.isConfigured(),
            api: this.effectiveApi(),
            bridgeIp: this.cfg.bridgeIp,
            eventStreamEnabled: !!this.cfg.enableEventStream
        };
    }

    start() {
        if (!this.isConfigured()) return;

        this.refreshAll().catch(() => {});

        this._pollTimer = setInterval(() => {
            this.refreshAll().catch(() => {});
        }, Math.max(3000, Number(this.cfg.pollIntervalMs) || 15000));

        if (this.effectiveApi() === "v2" && this.cfg.enableEventStream) {
            this._connectEventStream();
        }
    }

    stop() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;

        if (this._streamReq) {
            try { this._streamReq.destroy(); } catch (_) {}
        }
        this._streamReq = null;

        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;

        if (this._refreshDebounce) clearTimeout(this._refreshDebounce);
        this._refreshDebounce = null;
    }

    async getItems(type = "light") {
        const t = normaliseType(type);
        const entry = this._cache.get(t) || { items: [], ts: 0 };
        return { type: t, items: entry.items, updatedAt: entry.ts };
    }

    async refreshAll() {
        const api = this.effectiveApi();
        if (api === "v1") {
            await this.refresh("light");
            return;
        }
        await Promise.allSettled([this.refresh("light"), this.refresh("grouped_light")]);
    }

    async refresh(type = "light") {
        const t = normaliseType(type);
        if (!this.isConfigured()) return;

        const api = this.effectiveApi();
        let items = [];

        if (api === "v1") {
            if (t !== "light") {
                this._setCache(t, []);
                return;
            }
            items = await this._v1ListLights();
            this._setCache("light", items);
            return;
        }

        if (t === "grouped_light") {
            items = await this._v2ListGroupedLights();
            this._setCache("grouped_light", items);
            return;
        }

        items = await this._v2ListLights();
        this._setCache("light", items);
    }

    async setState({ type = "light", id, on, rgb, briPct }) {
        if (!this.isConfigured()) throw new Error("Hue not configured");
        if (!id) throw new Error("Missing id");

        const t = normaliseType(type);
        const api = this.effectiveApi();

        briPct = Number.isFinite(Number(briPct)) ? Math.max(1, Math.min(100, Number(briPct))) : undefined;

        if (api === "v1") {
            if (t !== "light") throw new Error("v1 does not support grouped_light here");
            await this._writer.enqueue(() => this._v1SetLightState({ id, on, rgb, briPct }));
            await this.refresh("light").catch(() => {});
            return;
        }

        await this._writer.enqueue(() => this._v2SetResourceState({ type: t, id, on, rgb, briPct }));
        await this.refresh(t).catch(() => {});
    }

    async executeTextCommand(text, type = "light") {
        const parsed = parseTextCommand(String(text || ""));
        if (!parsed) throw new Error("Could not parse command");
        const t = normaliseType(type);

        const { items } = await this.getItems(t);
        const targets = resolveTargets(items || [], parsed.target);
        if (!targets.length) throw new Error("No matching Hue items");

        if (parsed.action === "on" || parsed.action === "off") {
            for (const it of targets) await this.setState({ type: t, id: it.id, on: parsed.action === "on" });
            return;
        }
        if (parsed.action === "toggle") {
            for (const it of targets) await this.setState({ type: t, id: it.id, on: !it.on });
            return;
        }
        if (parsed.action === "color") {
            for (const it of targets) await this.setState({ type: t, id: it.id, on: true, rgb: parsed.rgb, briPct: parsed.briPct });
            return;
        }

        throw new Error("Unknown command");
    }

    _setCache(type, items) {
        const ts = Date.now();
        this._cache.set(type, { items, ts });
        this.emit("update", { type, items, updatedAt: ts });
    }

    async _v1ListLights() {
        const json = await this._requestJson({
            method: "GET",
            path: `/api/${encodeURIComponent(this.cfg.userId)}/lights`
        });

        const out = [];
        for (const id of Object.keys(json || {})) {
            const light = json[id] || {};
            const state = light.state || {};

            const on = !!state.on;
            const reachable = state.reachable !== false;
            const rgb = (on && reachable) ? deriveCssRgbFromV1State(state) : null;

            out.push({ id: String(id), type: "light", name: light.name || `Light ${id}`, on, reachable, rgb });
        }
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return out;
    }

    async _v1SetLightState({ id, on, rgb, briPct }) {
        const body = {};
        if (typeof on === "boolean") body.on = on;
        if (Number.isFinite(Number(briPct))) body.bri = Math.max(1, Math.min(254, Math.round(Number(briPct) * 254 / 100)));
        if (rgb) {
            const { r, g, b } = parseCssOrHexRgb(rgb);
            const xy = rgbToXy(r, g, b);
            body.xy = [xy.x, xy.y];
            if (typeof on !== "boolean") body.on = true;
        }

        await this._requestJson({
            method: "PUT",
            path: `/api/${encodeURIComponent(this.cfg.userId)}/lights/${encodeURIComponent(id)}/state`,
            body
        });
    }


    async _v2ListLights() {
        const headers = { "hue-application-key": this.cfg.hueApplicationKey };
        const json = await this._requestJson({ method: "GET", path: "/clip/v2/resource/light", headers });

        const out = [];
        for (const l of (json.data || [])) {
            const id = String(l.id);
            const name = l?.metadata?.name ? String(l.metadata.name) : `Light ${id}`;
            const on = !!l?.on?.on;

            const briPct = Number.isFinite(Number(l?.dimming?.brightness)) ? Number(l.dimming.brightness) : 100;
            const bri254 = Math.max(1, Math.min(254, Math.round(briPct * 254 / 100)));

            const xy = (Number.isFinite(Number(l?.color?.xy?.x)) && Number.isFinite(Number(l?.color?.xy?.y)))
                ? { x: Number(l.color.xy.x), y: Number(l.color.xy.y) } : null;

            const rgb = on ? deriveCssRgbFromXy({ xy, bri: bri254 }) : null;

            out.push({ id, type: "light", name, on, reachable: true, rgb });
        }
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return out;
    }

    async _v2ListGroupedLights() {
        const headers = { "hue-application-key": this.cfg.hueApplicationKey };

        const grouped = await this._requestJson({ method: "GET", path: "/clip/v2/resource/grouped_light", headers });
        const rooms = await this._requestJson({ method: "GET", path: "/clip/v2/resource/room", headers }).catch(() => ({ data: [] }));

        const roomNameById = new Map((rooms.data || []).map(r => [String(r.id), String(r?.metadata?.name || r.id)]));

        const out = [];
        for (const g of (grouped.data || [])) {
            const id = String(g.id);
            const ownerRid = g?.owner?.rid ? String(g.owner.rid) : "";
            const name = roomNameById.get(ownerRid) || `Room ${id}`;

            const on = !!g?.on?.on;

            const briPct = Number.isFinite(Number(g?.dimming?.brightness)) ? Number(g.dimming.brightness) : 100;
            const bri254 = Math.max(1, Math.min(254, Math.round(briPct * 254 / 100)));

            const xy = (Number.isFinite(Number(g?.color?.xy?.x)) && Number.isFinite(Number(g?.color?.xy?.y)))
                ? { x: Number(g.color.xy.x), y: Number(g.color.xy.y) } : null;

            const rgb = on ? deriveCssRgbFromXy({ xy, bri: bri254 }) : null;

            out.push({ id, type: "grouped_light", name, on, reachable: true, rgb });
        }
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return out;
    }

    async _v2SetResourceState({ type, id, on, rgb, briPct }) {
        const headers = { "hue-application-key": this.cfg.hueApplicationKey };
        const body = {};

        if (typeof on === "boolean") body.on = { on };
        if (Number.isFinite(Number(briPct))) body.dimming = { brightness: briPct };

        if (rgb) {
            const { r, g, b } = parseCssOrHexRgb(rgb);
            const xy = rgbToXy(r, g, b);
            body.color = { xy: { x: xy.x, y: xy.y } };
            if (typeof on !== "boolean") body.on = { on: true };
        }

        await this._requestJson({
            method: "PUT",
            path: `/clip/v2/resource/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
            headers,
            body
        });
    }


    _requestJson({ method, path, headers = {}, body }) {
        return new Promise((resolve, reject) => {
            const host = String(this.cfg.bridgeIp || "");
            if (!host) return reject(new Error("Missing bridgeIp"));

            const reqHeaders = { "Accept": "application/json", ...headers };
            let payload = null;

            if (body !== undefined) {
                payload = JSON.stringify(body);
                reqHeaders["Content-Type"] = "application/json";
                reqHeaders["Content-Length"] = Buffer.byteLength(payload);
            }

            const req = https.request({
                host,
                port: 443,
                method,
                path,
                headers: reqHeaders,
                agent: this._agent,
                timeout: 10000
            }, (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (c) => { data += c; });
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        if (!data) return resolve({});
                        try { return resolve(JSON.parse(data)); } catch (_) { return resolve({}); }
                    }
                    return reject(new Error(`Hue HTTP ${res.statusCode}: ${data || res.statusMessage}`));
                });
            });

            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("Timeout")));

            if (payload) req.write(payload);
            req.end();
        });
    }

    _connectEventStream() {
        if (this._streamReq) return;
        if (!this.isConfigured()) return;
        if (this.effectiveApi() !== "v2") return;

        const host = String(this.cfg.bridgeIp);

        const req = https.request({
            host,
            port: 443,
            method: "GET",
            path: "/eventstream/clip/v2",
            headers: {
                "hue-application-key": this.cfg.hueApplicationKey,
                "Accept": "text/event-stream"
            },
            agent: this._agent
        }, (res) => {
            res.setEncoding("utf8");
            res.on("data", () => this._scheduleRefresh());
            res.on("end", () => this._scheduleReconnect());
        });

        req.on("error", () => this._scheduleReconnect());
        req.end();
        this._streamReq = req;
    }

    _scheduleRefresh() {
        if (this._refreshDebounce) return;
        this._refreshDebounce = setTimeout(() => {
            this._refreshDebounce = null;
            this.refreshAll().catch(() => {});
        }, Math.max(200, Number(this.cfg.refreshDebounceMs) || 500));
    }

    _scheduleReconnect() {
        if (this._streamReq) {
            try { this._streamReq.destroy(); } catch (_) {}
            this._streamReq = null;
        }
        if (this._reconnectTimer) return;
        const wait = Math.min(30000, this._streamBackoff);
        this._streamBackoff = Math.min(30000, this._streamBackoff * 2);

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connectEventStream();
        }, wait);
    }
}


function normaliseType(type) {
    const t = String(type || "light").toLowerCase();
    return t === "grouped_light" ? "grouped_light" : "light";
}

class RateLimiter {
    constructor(minMs) {
        this.min = Math.max(0, Number(minMs) || 0);
        this.p = Promise.resolve();
        this.last = 0;
    }
    setMin(ms) { this.min = Math.max(0, Number(ms) || 0); }
    enqueue(fn) {
        this.p = this.p.then(async () => {
            const now = Date.now();
            const wait = Math.max(0, this.min - (now - this.last));
            if (wait) await new Promise(r => setTimeout(r, wait));
            const out = await fn();
            this.last = Date.now();
            return out;
        });
        return this.p;
    }
}

function resolveTargets(items, target) {
    const t = String(target || "").trim().toLowerCase();
    if (!t || t === "all") return items;
    return items.filter(x => String(x.name || "").toLowerCase().includes(t));
}

function parseTextCommand(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return null;

    if (t === "lights on" || t === "turn lights on" || t === "turn on lights") return { action: "on", target: "all" };
    if (t === "lights off" || t === "turn lights off" || t === "turn off lights") return { action: "off", target: "all" };
    if (t === "toggle lights" || t === "toggle light") return { action: "toggle", target: "all" };

    const m1 = t.match(/^turn\s+(on|off)\s+(.*?)\s+lights?$/);
    if (m1) return { action: m1[1], target: m1[2].trim() || "all" };

    const m2 = t.match(/^set\s+(.*?)\s+lights?\s+(.+)$/);
    if (m2) {
        const rgb = colourNameToHex(m2[2].trim());
        if (rgb) return { action: "color", target: m2[1].trim() || "all", rgb };
    }

    const m3 = t.match(/^set\s+lights?\s+(.+)$/);
    if (m3) {
        const rgb = colourNameToHex(m3[1].trim());
        if (rgb) return { action: "color", target: "all", rgb };
    }

    return null;
}

function colourNameToHex(name) {
    const n = String(name || "").trim().toLowerCase();
    const map = {
        red: "#ff0000",
        green: "#00ff00",
        blue: "#0000ff",
        white: "#ffffff"
    };
    return map[n] || null;
}

function parseCssOrHexRgb(input) {
    const s = String(input || "").trim().toLowerCase();
    const hex = s.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    return { r: 255, g: 255, b: 255 };
}

function clamp8(n) { return Math.max(0, Math.min(255, Math.round(Number(n) || 0))); }

function rgbToXy(r8, g8, b8) {
    let r = r8 / 255, g = g8 / 255, b = b8 / 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z || 1;
    return { x: X / sum, y: Y / sum };
}

function xyBriToRgb(x, y, bri) {
    const Y = Math.max(0, Math.min(1, bri / 254));
    const X = (Y / y) * x;
    const Z = (Y / y) * (1 - x - y);

    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;

    r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(r, 1 / 2.4) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(g, 1 / 2.4) - 0.055;
    b = b <= 0.0031308 ? 12.92 * b : 1.055 * Math.pow(b, 1 / 2.4) - 0.055;

    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
    const max = Math.max(r, g, b);
    if (max > 1) { r /= max; g /= max; b /= max; }

    return { r: clamp8(r * 255), g: clamp8(g * 255), b: clamp8(b * 255) };
}

function deriveCssRgbFromXy({ xy, bri }) {
    if (!xy || !Number.isFinite(xy.x) || !Number.isFinite(xy.y) || xy.y <= 0) return null;
    const { r, g, b } = xyBriToRgb(Number(xy.x), Number(xy.y), Number(bri) || 254);
    return `rgb(${r},${g},${b})`;
}

function deriveCssRgbFromV1State(state) {
    if (Array.isArray(state.xy) && state.xy.length === 2) {
        const { r, g, b } = xyBriToRgb(Number(state.xy[0]), Number(state.xy[1]), Number(state.bri) || 254);
        return `rgb(${r},${g},${b})`;
    }
    return null;
}

module.exports = HueBridge;
