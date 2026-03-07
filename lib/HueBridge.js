const https = require("https");
const EventEmitter = require("events");

class HueBridge extends EventEmitter {
    constructor(cfg = {}) {
        super();

        this.cfg = {
            enabled: false,
            apiVersion: "auto",
            bridgeIp: "",
            hueApplicationKey: "",
            userId: "",
            insecureSkipVerify: true,
            pollIntervalMs: 15000,
            minWriteIntervalMs: 120,
            ...cfg
        };

        this._agent = new https.Agent({ rejectUnauthorized: !this.cfg.insecureSkipVerify });
        this._cache = new Map();
        this._cache.set("light", { items: [], ts: 0 });
        this._cache.set("grouped_light", { items: [], ts: 0 });
        this._pollTimer = null;
        this._queue = Promise.resolve();
        this._lastWriteAt = 0;
    }

    configure(partial = {}) {
        this.cfg = { ...this.cfg, ...(partial || {}) };
        this._agent = new https.Agent({ rejectUnauthorized: !this.cfg.insecureSkipVerify });
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
            bridgeIp: this.cfg.bridgeIp
        };
    }

    start() {
        if (!this.isConfigured()) return;
        this.refreshAll().catch(() => {});
        this._pollTimer = setInterval(() => {
            this.refreshAll().catch(() => {});
        }, Math.max(3000, Number(this.cfg.pollIntervalMs) || 15000));
    }

    stop() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;
    }

    async getItems(type = "light") {
        const t = type === "grouped_light" ? "grouped_light" : "light";
        return this._cache.get(t) || { items: [], ts: 0 };
    }

    async refreshAll() {
        const api = this.effectiveApi();
        if (api === "v1") {
            const lights = await this._v1ListLights();
            this._setCache("light", lights);
            this._setCache("grouped_light", []);
            return;
        }

        const [lights, groups] = await Promise.all([
            this._v2ListLights(),
            this._v2ListGroupedLights()
        ]);

        this._setCache("light", lights);
        this._setCache("grouped_light", groups);
    }

    async setState({ type = "light", id, on, rgb, briPct }) {
        const t = type === "grouped_light" ? "grouped_light" : "light";
        const api = this.effectiveApi();

        await this._enqueueWrite(async () => {
            if (api === "v1") {
                if (t !== "light") throw new Error("v1 only supports individual lights here");
                await this._v1SetLightState({ id, on, rgb, briPct });
            } else {
                await this._v2SetResourceState({ type: t, id, on, rgb, briPct });
            }
        });

        await this.refreshAll();
    }

    async executeTextCommand(text, type = "light") {
        const parsed = parseTextCommand(text);
        if (!parsed) throw new Error("Could not parse command");

        const targetType = type === "grouped_light" ? "grouped_light" : "light";
        const current = await this.getItems(targetType);
        const targets = resolveTargets(current.items || [], parsed.target);

        if (!targets.length) throw new Error("No matching Hue items");

        for (const item of targets) {
            if (parsed.action === "on") {
                await this.setState({ type: targetType, id: item.id, on: true });
            } else if (parsed.action === "off") {
                await this.setState({ type: targetType, id: item.id, on: false });
            } else if (parsed.action === "toggle") {
                await this.setState({ type: targetType, id: item.id, on: !item.on });
            } else if (parsed.action === "color") {
                await this.setState({ type: targetType, id: item.id, on: true, rgb: parsed.rgb });
            }
        }
    }

    _setCache(type, items) {
        const update = { items, ts: Date.now() };
        this._cache.set(type, update);
        this.emit("update", { type, items, updatedAt: update.ts });
    }

    async _enqueueWrite(fn) {
        const minInterval = Math.max(0, Number(this.cfg.minWriteIntervalMs) || 120);

        this._queue = this._queue.then(async () => {
            const wait = Math.max(0, minInterval - (Date.now() - this._lastWriteAt));
            if (wait) await new Promise((r) => setTimeout(r, wait));
            const out = await fn();
            this._lastWriteAt = Date.now();
            return out;
        });

        return this._queue;
    }

    _requestJson({ method, path, headers = {}, body }) {
        return new Promise((resolve, reject) => {
            const reqHeaders = { Accept: "application/json", ...headers };
            let payload = null;

            if (body !== undefined) {
                payload = JSON.stringify(body);
                reqHeaders["Content-Type"] = "application/json";
                reqHeaders["Content-Length"] = Buffer.byteLength(payload);
            }

            const req = https.request({
                host: this.cfg.bridgeIp,
                port: 443,
                method,
                path,
                headers: reqHeaders,
                agent: this._agent,
                timeout: 10000
            }, (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        if (!data) return resolve({});
                        try { return resolve(JSON.parse(data)); } catch (_) { return resolve({}); }
                    }
                    reject(new Error(`Hue HTTP ${res.statusCode}: ${data || res.statusMessage}`));
                });
            });

            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("Hue request timeout")));

            if (payload) req.write(payload);
            req.end();
        });
    }

    async _v1ListLights() {
        const json = await this._requestJson({
            method: "GET",
            path: `/api/${encodeURIComponent(this.cfg.userId)}/lights`
        });

        return Object.keys(json || {}).map((id) => {
            const light = json[id] || {};
            const state = light.state || {};
            return {
                id: String(id),
                type: "light",
                name: light.name || `Light ${id}`,
                on: !!state.on,
                reachable: state.reachable !== false,
                rgb: Array.isArray(state.xy) ? xyToCssRgb(state.xy[0], state.xy[1], state.bri || 254) : null
            };
        }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    async _v1SetLightState({ id, on, rgb, briPct }) {
        const body = {};
        if (typeof on === "boolean") body.on = on;
        if (Number.isFinite(Number(briPct))) body.bri = Math.max(1, Math.min(254, Math.round(Number(briPct) * 254 / 100)));

        if (rgb) {
            const { r, g, b } = hexToRgb(rgb);
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
        const json = await this._requestJson({
            method: "GET",
            path: "/clip/v2/resource/light",
            headers: { "hue-application-key": this.cfg.hueApplicationKey }
        });

        return (json.data || []).map((light) => {
            const id = String(light.id);
            const x = light && light.color && light.color.xy ? Number(light.color.xy.x) : null;
            const y = light && light.color && light.color.xy ? Number(light.color.xy.y) : null;
            const bri = light && light.dimming ? Number(light.dimming.brightness || 100) : 100;

            return {
                id,
                type: "light",
                name: (light.metadata && light.metadata.name) ? String(light.metadata.name) : `Light ${id}`,
                on: !!(light.on && light.on.on),
                reachable: true,
                rgb: Number.isFinite(x) && Number.isFinite(y)
                    ? xyToCssRgb(x, y, Math.round((bri * 254) / 100))
                    : null
            };
        }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    async _v2ListGroupedLights() {
        const [grouped, rooms] = await Promise.all([
            this._requestJson({
                method: "GET",
                path: "/clip/v2/resource/grouped_light",
                headers: { "hue-application-key": this.cfg.hueApplicationKey }
            }),
            this._requestJson({
                method: "GET",
                path: "/clip/v2/resource/room",
                headers: { "hue-application-key": this.cfg.hueApplicationKey }
            }).catch(() => ({ data: [] }))
        ]);

        const roomNames = new Map((rooms.data || []).map((room) => [
            String(room.id),
            room && room.metadata && room.metadata.name ? String(room.metadata.name) : String(room.id)
        ]));

        return (grouped.data || []).map((group) => {
            const id = String(group.id);
            const ownerRid = group && group.owner ? String(group.owner.rid || "") : "";
            const x = group && group.color && group.color.xy ? Number(group.color.xy.x) : null;
            const y = group && group.color && group.color.xy ? Number(group.color.xy.y) : null;
            const bri = group && group.dimming ? Number(group.dimming.brightness || 100) : 100;

            return {
                id,
                type: "grouped_light",
                name: roomNames.get(ownerRid) || `Room ${id}`,
                on: !!(group.on && group.on.on),
                reachable: true,
                rgb: Number.isFinite(x) && Number.isFinite(y)
                    ? xyToCssRgb(x, y, Math.round((bri * 254) / 100))
                    : null
            };
        }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    async _v2SetResourceState({ type, id, on, rgb, briPct }) {
        const body = {};
        if (typeof on === "boolean") body.on = { on };
        if (Number.isFinite(Number(briPct))) body.dimming = { brightness: Math.max(1, Math.min(100, Number(briPct))) };

        if (rgb) {
            const { r, g, b } = hexToRgb(rgb);
            const xy = rgbToXy(r, g, b);
            body.color = { xy: { x: xy.x, y: xy.y } };
            if (typeof on !== "boolean") body.on = { on: true };
        }

        await this._requestJson({
            method: "PUT",
            path: `/clip/v2/resource/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
            headers: { "hue-application-key": this.cfg.hueApplicationKey },
            body
        });
    }
}

function parseTextCommand(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return null;

    if (t === "lights on" || t === "turn lights on" || t === "turn on lights") return { action: "on", target: "all" };
    if (t === "lights off" || t === "turn lights off" || t === "turn off lights") return { action: "off", target: "all" };
    if (t === "toggle lights") return { action: "toggle", target: "all" };

    const m1 = t.match(/^turn\s+(on|off)\s+(.*?)\s+lights?$/);
    if (m1) return { action: m1[1], target: m1[2] || "all" };

    const m2 = t.match(/^set\s+(.*?)\s+lights?\s+(red|green|blue|white)$/);
    if (m2) return { action: "color", target: m2[1] || "all", rgb: colourToHex(m2[2]) };

    const m3 = t.match(/^set\s+lights?\s+(red|green|blue|white)$/);
    if (m3) return { action: "color", target: "all", rgb: colourToHex(m3[1]) };

    return null;
}

function resolveTargets(items, target) {
    const t = String(target || "").trim().toLowerCase();
    if (!t || t === "all") return items;
    return items.filter((item) => String(item.name || "").toLowerCase().includes(t));
}

function colourToHex(name) {
    const map = {
        red: "#ff0000",
        green: "#00ff00",
        blue: "#0000ff",
        white: "#ffffff"
    };
    return map[String(name || "").toLowerCase()] || "#ffffff";
}

function hexToRgb(hex) {
    const clean = String(hex || "").replace("#", "");
    const num = parseInt(clean.padStart(6, "0"), 16);
    return {
        r: (num >> 16) & 255,
        g: (num >> 8) & 255,
        b: num & 255
    };
}

function rgbToXy(r8, g8, b8) {
    let r = r8 / 255;
    let g = g8 / 255;
    let b = b8 / 255;

    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z || 1;

    return { x: X / sum, y: Y / sum };
}

function xyToCssRgb(x, y, bri) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || Number(y) <= 0) return null;

    const Y = Math.max(0, Math.min(1, (Number(bri) || 254) / 254));
    const X = (Y / y) * x;
    const Z = (Y / y) * (1 - x - y);

    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;

    r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(r, 1 / 2.4) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(g, 1 / 2.4) - 0.055;
    b = b <= 0.0031308 ? 12.92 * b : 1.055 * Math.pow(b, 1 / 2.4) - 0.055;

    r = Math.max(0, Math.min(255, Math.round(r * 255)));
    g = Math.max(0, Math.min(255, Math.round(g * 255)));
    b = Math.max(0, Math.min(255, Math.round(b * 255)));

    return `rgb(${r},${g},${b})`;
}

module.exports = HueBridge;