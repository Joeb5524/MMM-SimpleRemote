const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const Ajv = require("ajv");
const jsonpatch = require("fast-json-patch");

module.exports = NodeHelper.create({
    start() {
        this.basePath = "/mm-simple-remote";
        this.maxQueue = 25;

        this.dataDir = path.join(__dirname, "data");
        this.alertsFile = path.join(this.dataDir, "alerts.json");

        this._ensureDir(this.dataDir);

        this.queue = this._loadAlerts();
        this.active = null;
        this.activeUntil = 0;

        this._setupExpress();
    },

    socketNotificationReceived(notification, payload) {
        if (notification === "SR_INIT") {
            if (payload && typeof payload.basePath === "string") {
                this.basePath = payload.basePath.startsWith("/") ? payload.basePath : `/${payload.basePath}`;
            }
            if (payload && Number.isFinite(payload.maxQueue)) this.maxQueue = payload.maxQueue;
            return;
        }

        if (notification === "SR_DISMISS_ACTIVE") {
            this.active = null;
            this.activeUntil = 0;
            this._broadcastActive();
            this._tickQueue();
        }
        if (notification === "SR_ACK_ACTIVE" && payload && payload.id) {
            this._logAck(payload.id);
            this.active = null;
            this.activeUntil = 0;
            this._broadcastActive();
            this._tickQueue();

        }
    },

    _setupExpress() {
        const app = this.expressApp;
        app.set("trust proxy", 1);

        app.use(helmet({
            contentSecurityPolicy: false
        }));

        const sessionSecret = process.env.SR_SESSION_SECRET;
        if (!sessionSecret || sessionSecret.length < 24) {
            console.warn("[MMM-SimpleRemote] SR_SESSION_SECRET is missing or too short.");
        }

        app.use(session({
            name: "sr.sid",
            secret: sessionSecret || "CHANGE_ME_LONG_RANDOM_SECRET",
            resave: false,
            saveUninitialized: false,
            cookie: {
                httpOnly: true,
                sameSite: "lax",
                secure: true
            }
        }));


        app.use(`${this.basePath}`, this._static(path.join(__dirname, "public")));

        app.get(`${this.basePath}`, (req, res) => {
            if (!this._isAuthed(req)) return res.redirect(`${this.basePath}/login`);
            return res.redirect(`${this.basePath}/dashboard`);
        });

        app.get(`${this.basePath}/login`, (req, res) => {
            res.sendFile(path.join(__dirname, "public", "login.html"));
        });

        app.post(`${this.basePath}/api/login`, this._jsonBody(), (req, res) => {
            const user = (req.body && req.body.username) ? String(req.body.username) : "";
            const pass = (req.body && req.body.password) ? String(req.body.password) : "";

            const ok = this._checkLogin(user, pass);
            if (!ok) return res.status(401).json({ ok: false });

            req.session.user = user;
            return res.json({ ok: true });
        });

        app.post(`${this.basePath}/api/logout`, (req, res) => {
            req.session.destroy(() => res.json({ ok: true }));
        });

        app.get(`${this.basePath}/dashboard`, (req, res) => {
            if (!this._isAuthed(req)) return res.redirect(`${this.basePath}/login`);
            res.sendFile(path.join(__dirname, "public", "dashboard.html"));
        });

        app.get(`${this.basePath}/config`, (req, res) => {
            if (!this._isAuthed(req)) return res.redirect(`${this.basePath}/login`);
            res.sendFile(path.join(__dirname, "public", "config.html"));
        });

        // Alerts API
        app.get(`${this.basePath}/api/alerts`, this._requireAuth.bind(this), (req, res) => {
            res.json({ ok: true, queue: this.queue, active: this.active, activeUntil: this.activeUntil });
        });

        app.post(`${this.basePath}/api/alerts`, this._requireAuth.bind(this), this._jsonBody(), (req, res) => {
            const title = this._cleanText(req.body && req.body.title, 80) || "Alert";
            const message = this._cleanText(req.body && req.body.message, 2000);

            if (!message) return res.status(400).json({ ok: false, error: "Message required" });

            const item = {
                id: this._id(),
                title,
                message,
                createdAt: Date.now()
            };

            this.queue.push(item);
            if (this.queue.length > this.maxQueue) this.queue.shift();

            this._saveAlerts();
            this._broadcastSync();
            this._tickQueue();

            res.json({ ok: true, item });
        });

        app.delete(`${this.basePath}/api/alerts/:id`, this._requireAuth.bind(this), (req, res) => {
            const id = String(req.params.id || "");
            const before = this.queue.length;
            this.queue = this.queue.filter(a => a.id !== id);

            if (this.active && this.active.id === id) {
                this.active = null;
                this.activeUntil = 0;
                this._broadcastActive();
            }

            if (this.queue.length !== before) this._saveAlerts();
            this._broadcastSync();
            res.json({ ok: true });
        });

        app.post(`${this.basePath}/api/alerts/clear`, this._requireAuth.bind(this), (req, res) => {
            this.queue = [];
            this.active = null;
            this.activeUntil = 0;
            this._saveAlerts();
            this._broadcastSync();
            this._broadcastActive();
            this.sendSocketNotification("SR_ACTION", { type: "REFRESH" });
            res.json({ ok: true });
        });

        // Config API: list modules
        app.get(`${this.basePath}/api/config/modules`, this._requireAuth.bind(this), (req, res) => {
            try {
                const cfg = this._loadConfigObject(true);
                const list = (cfg.modules || []).map((m, idx) => ({
                    index: idx,
                    module: m && m.module ? m.module : null,
                    position: m && m.position ? m.position : null,
                    header: m && m.header ? m.header : null
                })).filter(x => x.module);

                res.json({ ok: true, modules: list });
            } catch (e) {
                res.status(500).json({ ok: false, error: "Failed to read config.js" });
            }
        });

        // Config API: read one module config
        app.get(`${this.basePath}/api/config/module`, this._requireAuth.bind(this), (req, res) => {
            const moduleName = String(req.query.name || "");
            const index = Number(req.query.index);

            try {
                const cfg = this._loadConfigObject(true);
                const idx = this._findModuleIndex(cfg, moduleName, index);
                if (idx === -1) return res.status(404).json({ ok: false, error: "Module not found" });

                const mod = cfg.modules[idx];
                res.json({ ok: true, module: mod.module, index: idx, config: mod.config || {} });
            } catch (e) {
                res.status(500).json({ ok: false, error: "Failed to read config.js" });
            }
        });
        // Config API: get schema for module
        app.get(`${this.basePath}/api/config/schema`, this._requireAuth.bind(this), (req, res) => {
            const moduleName = String(req.query.name || "");
            if (!moduleName) return res.status(400).json({ ok: false, error: "Missing module name" });

            const out = this._loadSchema(moduleName);
            if (!out) return res.status(404).json({ ok: false, error: "Schema not found" });

            return res.json({ ok: true, schema: out });
        });


        app.patch(`${this.basePath}/api/config/module`, this._requireAuth.bind(this), this._jsonBody(), (req, res) => {
            const moduleName = this._cleanText(req.body && req.body.name, 80);
            const index = Number(req.body && req.body.index);
            const newConfig = req.body && req.body.config;

            if (!moduleName) return res.status(400).json({ ok: false, error: "Missing module name" });
            if (!newConfig || typeof newConfig !== "object" || Array.isArray(newConfig)) {
                return res.status(400).json({ ok: false, error: "config must be an object" });
            }

            const configPath = this._magicMirrorConfigPath();
            const backupPath = `${configPath}.bak`;

            try {
                this._backupFile(configPath, backupPath);

                const cfg = this._loadConfigObject(true);
                const idx = this._findModuleIndex(cfg, moduleName, index);
                if (idx === -1) return res.status(404).json({ ok: false, error: "Module not found" });

                const schemaResult = this._validateSchema(moduleName, newConfig);
                if (!schemaResult.ok) {
                    this._restoreFile(backupPath, configPath);
                    return res.status(422).json({ ok: false, error: "Schema validation failed", details: schemaResult.errors });
                }

                cfg.modules[idx].config = newConfig;

                this._writeConfigObject(cfg);
                this._broadcastConfigUpdated(moduleName, idx);

                res.json({ ok: true });
            } catch (e) {
                try { this._restoreFile(backupPath, configPath); } catch (_) {}
                res.status(500).json({ ok: false, error: "Failed to update config.js" });
            }
        });

        // optional
        app.post(`${this.basePath}/api/external/alert`, this._jsonBody(), (req, res) => {
            const key = process.env.SR_EXTERNAL_KEY;
            if (!key) return res.status(403).json({ ok: false });

            const provided = String((req.headers["x-api-key"] || "")).trim();
            if (provided !== key) return res.status(401).json({ ok: false });

            const title = this._cleanText(req.body && req.body.title, 80) || "Alert";
            const message = this._cleanText(req.body && req.body.message, 2000);
            if (!message) return res.status(400).json({ ok: false, error: "Message required" });

            const item = { id: this._id(), title, message, createdAt: Date.now() };

            this.queue.push(item);
            if (this.queue.length > this.maxQueue) this.queue.shift();

            this._saveAlerts();
            this._broadcastSync();
            this._tickQueue();

            res.json({ ok: true });
        });
    },

    _requireAuth(req, res, next) {
        if (!this._isAuthed(req)) return res.status(401).json({ ok: false });
        next();
    },

    _isAuthed(req) {
        return !!(req.session && req.session.user);
    },

    _checkLogin(username, password) {
        const u = String(username || "");


        // Multi-user list from env
        const usersJson = process.env.SR_USERS_JSON;
        if (usersJson) {
            try {
                const users = JSON.parse(usersJson);
                if (Array.isArray(users)) {
                    const match = users.find(x => x && x.username === u && typeof x.passHash === "string");
                    if (!match) return false;
                    return bcrypt.compareSync(password, match.passHash);
                }
            } catch (_) {
                return false;
            }
        }

        // Single admin fallback
        const expectedUser = process.env.SR_ADMIN_USER || "";
        const passHash = process.env.SR_ADMIN_PASS_HASH || "";
        if (!expectedUser || !passHash) return false;
        if (u !== expectedUser) return false;
        return bcrypt.compareSync(password, passHash);
    },

    _static(dir) {
        return require("express").static(dir, { maxAge: "1h" });
    },

    _jsonBody() {
        const express = require("express");
        return express.json({ limit: "256kb" });
    },

    _cleanText(value, maxLen) {
        if (value === undefined || value === null) return "";
        const s = String(value).replace(/\r/g, "").trim();
        if (!s) return "";
        return s.length > maxLen ? s.slice(0, maxLen) : s;
    },

    _id() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
        } catch (e) {
            return [];
        }
    },

    _saveAlerts() {
        try {
            fs.writeFileSync(this.alertsFile, JSON.stringify(this.queue, null, 2), "utf8");
        } catch (e) {}
    },

    _broadcastSync() {
        this.sendSocketNotification("SR_ALERTS_SYNC", { queue: this.queue });
    },

    _broadcastActive() {
        this.sendSocketNotification("SR_ACTIVE_CHANGED", { active: this.active, activeUntil: this.activeUntil });
    },

    _tickQueue() {
        const now = Date.now();
        if (this.active && now < this.activeUntil) return;

        if (!this.queue.length) {
            if (this.active) {
                this.active = null;
                this.activeUntil = 0;
                this._broadcastActive();
            }
            return;
        }

        this.active = this.queue.shift();
        this.activeUntil = now + (20 * 1000);
        this._saveAlerts();
        this._broadcastSync();
        this._broadcastActive();
    },

    _magicMirrorConfigPath() {
        return path.join(process.env.HOME || "/home/pi", "MagicMirror", "config", "config.js");
    },

    _loadConfigObject(skipCache = false) {
        const configPath = this._magicMirrorConfigPath();

        if (skipCache) {
            delete require.cache[require.resolve(configPath)];
        }

        const cfg = require(configPath);
        if (!cfg || typeof cfg !== "object") throw new Error("Invalid config export");
        return JSON.parse(JSON.stringify(cfg));
    },

    _findModuleIndex(cfg, moduleName, index) {
        const modules = Array.isArray(cfg.modules) ? cfg.modules : [];
        for (let i = 0; i < modules.length; i++) {
            const m = modules[i];
            if (!m || m.module !== moduleName) continue;

            if (Number.isFinite(index)) {
                if (i === index) return i;
            } else {
                return i;
            }
        }
        return -1;
    },

    _backupFile(src, dst) {
        fs.copyFileSync(src, dst);
    },

    _restoreFile(src, dst) {
        fs.copyFileSync(src, dst);
    },

    _writeConfigObject(cfgObj) {
        const configPath = this._magicMirrorConfigPath();
        const tmpPath = `${configPath}.tmp`;
        const out = "module.exports = " + JSON.stringify(cfgObj, null, 2) + ";\n";
        fs.writeFileSync(tmpPath, out, "utf8");
        fs.renameSync(tmpPath, configPath);
    },

    _validateSchema(moduleName, moduleConfig) {
        const schemaPath = path.join(__dirname, "schemas", `${moduleName}.schema.json`);
        if (!fs.existsSync(schemaPath)) return { ok: true };

        try {
            const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
            const ajv = new Ajv({ allErrors: true, strict: false });
            const validate = ajv.compile(schema);
            const ok = validate(moduleConfig);
            if (ok) return { ok: true };
            return { ok: false, errors: validate.errors || [] };
        } catch (e) {
            return { ok: false, errors: [{ message: "Schema file could not be used" }] };
        }
    },

    _broadcastConfigUpdated(moduleName, index) {
        this.sendSocketNotification("SR_ACTION", { type: "REFRESH" });
        console.log(`[MMM-SimpleRemote] config updated: ${moduleName} @ ${index}`);
    },
    _logAck(id) {
        try {
            const ackFile = path.join(this.dataDir, "acks.json");
            let acks = [];
            if (fs.existsSync(ackFile)) {
                acks = JSON.parse(fs.readFileSync(ackFile, "utf8")) || [];
                if (!Array.isArray(acks)) acks = [];
            }
            acks.push({ id: String(id), acknowledgedAt: Date.now() });
            fs.writeFileSync(ackFile, JSON.stringify(acks, null, 2), "utf8");
        } catch (e) {}
    }
});
