const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const helmet = require("helmet");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const express = require("express");

const HueBridge = require("./lib/HueBridge");

module.exports = NodeHelper.create({
    start() {
        this.basePath = "/mm-simple-remote";
        this.maxQueue = 25;

        this.dataDir = path.join(__dirname, "data");
        this.alertsFile = path.join(this.dataDir, "alerts.json");
        this.authFile = path.join(this.dataDir, "auth.json");

        this._ensureDir(this.dataDir);

        this.authStore = this._loadOrCreateAuthStore();
        this.queue = this._loadAlerts();

        this.hue = new HueBridge(this._loadHueEnv());
        this._hueClients = new Set();

        this.hue.on("update", (u) => this._broadcastHue(u));
        this.hue.start();

        this._setupExpress();
    },

    socketNotificationReceived(notification, payload) {
        if (notification !== "SR_INIT") return;

        if (payload && typeof payload.basePath === "string") {
            this.basePath = payload.basePath.startsWith("/") ? payload.basePath : `/${payload.basePath}`;
        }
        if (payload && Number.isFinite(payload.maxQueue)) this.maxQueue = payload.maxQueue;

        if (payload && payload.hue && typeof payload.hue === "object") {
            this.hue.configure(payload.hue);
        }
    },

    _loadHueEnv() {
        const toBool = (v, def) => {
            if (v === undefined || v === null || v === "") return def;
            return !["0", "false", "no", "off"].includes(String(v).toLowerCase());
        };

        return {
            enabled: toBool(process.env.SR_HUE_ENABLED, false),
            apiVersion: process.env.SR_HUE_API_VERSION || "auto",
            bridgeIp: process.env.SR_HUE_BRIDGE_IP || "",
            hueApplicationKey: process.env.SR_HUE_APPLICATION_KEY || "",
            userId: process.env.SR_HUE_USER_ID || "",
            insecureSkipVerify: toBool(process.env.SR_HUE_INSECURE_SKIP_VERIFY, true),
            pollIntervalMs: Number(process.env.SR_HUE_POLL_INTERVAL_MS || 15000),
            enableEventStream: toBool(process.env.SR_HUE_ENABLE_EVENTSTREAM, true)
        };
    },

    _setupExpress() {
        const app = this.expressApp;
        app.set("trust proxy", 1);

        app.use(helmet({ contentSecurityPolicy: false }));

        app.use(session({
            name: "sr.sid",
            secret: this._getSessionSecret(),
            resave: false,
            saveUninitialized: false,
            cookie: {
                httpOnly: true,
                sameSite: "lax",
                secure: true
            }
        }));

        app.use(`${this.basePath}`, express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
        app.use(express.json({ limit: "256kb" }));

        app.get(`${this.basePath}`, (req, res) => {
            if (this._needsSetup()) return res.redirect(`${this.basePath}/setup`);
            if (!this._isAuthed(req)) return res.redirect(`${this.basePath}/login`);
            return res.redirect(`${this.basePath}/dashboard`);
        });

        app.get(`${this.basePath}/setup`, (req, res) => {
            res.sendFile(path.join(__dirname, "public", "setup.html"));
        });

        app.get(`${this.basePath}/login`, (req, res) => {
            res.sendFile(path.join(__dirname, "public", "login.html"));
        });

        app.get(`${this.basePath}/dashboard`, (req, res) => {
            if (this._needsSetup()) return res.redirect(`${this.basePath}/setup`);
            if (!this._isAuthed(req)) return res.redirect(`${this.basePath}/login`);
            res.sendFile(path.join(__dirname, "public", "dashboard.html"));
        });

        app.get(`${this.basePath}/api/bootstrap/status`, (req, res) => {
            res.json({ ok: true, needsSetup: this._needsSetup() });
        });

        app.post(`${this.basePath}/api/bootstrap/setup`, (req, res) => {
            if (!this._needsSetup()) return res.status(409).json({ ok: false, error: "Already set up" });

            const username = cleanText(req.body && req.body.username, 64);
            const password = String((req.body && req.body.password) || "");
            const confirm = String((req.body && req.body.confirmPassword) || "");

            if (!username) return res.status(400).json({ ok: false, error: "Username required" });
            if (password.length < 8) return res.status(400).json({ ok: false, error: "Password must be >= 8 chars" });
            if (password !== confirm) return res.status(400).json({ ok: false, error: "Passwords do not match" });

            const passHash = bcrypt.hashSync(password, 10);
            this.authStore.users = [{ username, passHash, createdAt: Date.now() }];
            this.authStore.updatedAt = Date.now();
            this._saveAuthStore();

            req.session.user = username;
            res.json({ ok: true });
        });

        app.post(`${this.basePath}/api/login`, (req, res) => {
            if (this._needsSetup()) return res.status(409).json({ ok: false, needsSetup: true });

            const username = String((req.body && req.body.username) || "");
            const password = String((req.body && req.body.password) || "");
            if (!this._checkLogin(username, password)) return res.status(401).json({ ok: false });

            req.session.user = username;
            res.json({ ok: true });
        });

        app.post(`${this.basePath}/api/logout`, (req, res) => {
            req.session.destroy(() => res.json({ ok: true }));
        });


        const requireAuth = (req, res, next) => {
            if (this._needsSetup()) return res.status(409).json({ ok: false, needsSetup: true });
            if (!this._isAuthed(req)) return res.status(401).json({ ok: false });
            next();
        };


        app.get(`${this.basePath}/api/alerts`, requireAuth, (req, res) => {
            res.json({ ok: true, queue: this.queue });
        });

        app.post(`${this.basePath}/api/alerts`, requireAuth, (req, res) => {
            const title = cleanText(req.body && req.body.title, 80) || "Alert";
            const message = cleanText(req.body && req.body.message, 2000);
            if (!message) return res.status(400).json({ ok: false, error: "Message required" });

            const item = { id: id(), title, message, createdAt: Date.now() };
            this.queue.push(item);
            if (this.queue.length > this.maxQueue) this.queue.shift();

            this._saveAlerts();
            res.json({ ok: true, item });
        });

        app.post(`${this.basePath}/api/alerts/clear`, requireAuth, (req, res) => {
            this.queue = [];
            this._saveAlerts();
            res.json({ ok: true });
        });

        app.delete(`${this.basePath}/api/alerts/:id`, requireAuth, (req, res) => {
            const id = String(req.params.id || "");
            this.queue = this.queue.filter(a => a.id !== id);
            this._saveAlerts();
            res.json({ ok: true });
        });

        // Hue
        app.get(`${this.basePath}/api/hue/status`, requireAuth, (req, res) => {
            const st = this.hue.status();
            res.json({ ok: true, ...st });
        });

        app.get(`${this.basePath}/api/hue/items`, requireAuth, async (req, res) => {
            try {
                const type = String(req.query.type || "light");
                const out = await this.hue.getItems(type);
                res.json({ ok: true, type: out.type, items: out.items, updatedAt: out.updatedAt });
            } catch (e) {
                res.status(500).json({ ok: false, error: e.message });
            }
        });

        app.put(`${this.basePath}/api/hue/items/:id`, requireAuth, async (req, res) => {
            try {
                const id = String(req.params.id || "");
                const type = String((req.body && req.body.type) || "light");
                await this.hue.setState({
                    type,
                    id,
                    on: typeof req.body.on === "boolean" ? req.body.on : undefined,
                    rgb: req.body.rgb ? String(req.body.rgb) : undefined,
                    briPct: Number.isFinite(Number(req.body.briPct)) ? Number(req.body.briPct) : undefined
                });
                res.json({ ok: true });
            } catch (e) {
                res.status(500).json({ ok: false, error: e.message });
            }
        });

        app.post(`${this.basePath}/api/hue/command`, requireAuth, async (req, res) => {
            try {
                const text = String((req.body && req.body.text) || "");
                const type = String((req.body && req.body.type) || "light");
                await this.hue.executeTextCommand(text, type);
                res.json({ ok: true });
            } catch (e) {
                res.status(400).json({ ok: false, error: e.message });
            }
        });


        app.get(`${this.basePath}/api/hue/stream`, requireAuth, async (req, res) => {
            res.status(200);
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");

            res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);
            res.write(`event: status\ndata: ${JSON.stringify(this.hue.status())}\n\n`);

            const client = { res };
            this._hueClients.add(client);

            const hb = setInterval(() => {
                try { res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch (_) {}
            }, 15000);

            req.on("close", () => {
                clearInterval(hb);
                this._hueClients.delete(client);
            });
        });
    },

    _broadcastHue(update) {
        for (const c of this._hueClients) {
            try {
                c.res.write(`event: hue\ndata: ${JSON.stringify(update)}\n\n`);
            } catch (_) {}
        }
    },

    _ensureDir(dir) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    },

    _loadAlerts() {
        try {
            if (!fs.existsSync(this.alertsFile)) return [];
            const raw = fs.readFileSync(this.alertsFile, "utf8");
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    },

    _saveAlerts() {
        try {
            fs.writeFileSync(this.alertsFile, JSON.stringify(this.queue, null, 2), "utf8");
        } catch (_) {}
    },

    _needsSetup() {
        return !Array.isArray(this.authStore.users) || this.authStore.users.length === 0;
    },

    _isAuthed(req) {
        return !!(req.session && req.session.user);
    },

    _checkLogin(username, password) {
        const u = String(username || "");
        const users = Array.isArray(this.authStore.users) ? this.authStore.users : [];
        const row = users.find(x => x && x.username === u);
        if (!row) return false;
        return bcrypt.compareSync(password, row.passHash);
    },

    _getSessionSecret() {
        const env = process.env.SR_SESSION_SECRET;
        if (env && env.length >= 24) return env;
        return this.authStore.sessionSecret;
    },

    _loadOrCreateAuthStore() {
        const fallback = {
            sessionSecret: crypto.randomBytes(48).toString("base64url"),
            users: [],
            updatedAt: Date.now()
        };

        try {
            if (fs.existsSync(this.authFile)) {
                const raw = fs.readFileSync(this.authFile, "utf8");
                const parsed = JSON.parse(raw);
                if (parsed && parsed.sessionSecret) return parsed;
            }
        } catch (_) {}

        try {
            fs.writeFileSync(this.authFile, JSON.stringify(fallback, null, 2), { encoding: "utf8", mode: 0o600 });
        } catch (_) {}

        return fallback;
    },

    _saveAuthStore() {
        try {
            fs.writeFileSync(this.authFile, JSON.stringify(this.authStore, null, 2), { encoding: "utf8", mode: 0o600 });
        } catch (_) {}
    }
});

function cleanText(v, maxLen) {
    if (v === undefined || v === null) return "";
    const s = String(v).replace(/\r/g, "").trim();
    if (!s) return "";
    return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function id() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
