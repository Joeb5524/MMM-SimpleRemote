const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const Ajv = require("ajv");

const HueBridge = require("./lib/HueBridge");

module.exports = NodeHelper.create({
    start() {
        this.basePath = "/mm-simple-remote";
        this.maxQueue = 25;

        this.dataDir = path.join(__dirname, "data");
        this.alertsFile = path.join(this.dataDir, "alerts.json");
        this.authFile = path.join(this.dataDir, "auth.json");

        this.careFile = path.join(this.dataDir, "care_alerts.json");
        this.mirrorToken = process.env.SR_MIRROR_TOKEN || "";
        this.careQueue = this._loadCareAlerts();
        this.rtcSessions = new Map();
        this.rtcSeq = 0;


        this._ensureDir(this.dataDir);

        this.authStore = this._loadOrCreateAuthStore();
        this.queue = this._loadAlerts();
        this.active = null;
        this.activeUntil = 0;

        this.hue = new HueBridge(this._loadHueEnv());

        this._setupExpress();

        this.hue.start();
    },

    socketNotificationReceived(notification, payload) {
        if (notification === "SR_INIT") {
            if (payload && typeof payload.basePath === "string") {
                this.basePath = payload.basePath.startsWith("/") ? payload.basePath : `/${payload.basePath}`;
            }
            if (payload && Number.isFinite(payload.maxQueue)) this.maxQueue = payload.maxQueue;

            if (payload && typeof payload.mirrorToken === "string") {
                this.mirrorToken = String(payload.mirrorToken || "").trim();
            }


            if (payload && payload.hue && typeof payload.hue === "object") {
                this.hue.configure(payload.hue);
            }
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

    _loadHueEnv() {
        const toBool = (v, fallback) => {
            if (v === undefined || v === null || v === "") return fallback;
            return !["0", "false", "no", "off"].includes(String(v).toLowerCase());
        };

        return {
            enabled: toBool(process.env.SR_HUE_ENABLED, false),
            apiVersion: process.env.SR_HUE_API_VERSION || "auto",
            bridgeIp: process.env.SR_HUE_BRIDGE_IP || "",
            hueApplicationKey: process.env.SR_HUE_APPLICATION_KEY || "",
            userId: process.env.SR_HUE_USER_ID || "",
            insecureSkipVerify: toBool(process.env.SR_HUE_INSECURE_SKIP_VERIFY, true),
            pollIntervalMs: Number(process.env.SR_HUE_POLL_INTERVAL_MS || 15000)
        };
    },

    _setupExpress() {
        const app = this.expressApp;
        app.set("trust proxy", 1);

        app.use(helmet({contentSecurityPolicy: false}));

        const sessionSecret = this._getSessionSecret();
        app.use(session({
            name: "sr.sid",
            secret: sessionSecret,
            resave: false,
            saveUninitialized: false,
            cookie: {
                httpOnly: true,
                sameSite: "lax",
                secure: false
            }
        }));

        app.use(`${this.basePath}`, this._static(path.join(__dirname, "public")));

        app.get(`${this.basePath}`, (req, res) => {
            if (this._needsBootstrap()) return res.redirect(`${this.basePath}/setup`);
            if (!this._isAuthed(req)) return res.redirect(`${this.basePath}/login`);
            return res.redirect(`${this.basePath}/dashboard`);
        });

        app.get(`${this.basePath}/login`, (req, res) => {
            if (this._needsBootstrap()) return res.redirect(`${this.basePath}/setup`);
            if (this._isAuthed(req)) return res.redirect(`${this.basePath}/dashboard`);
            res.sendFile(path.join(__dirname, "public", "login.html"));
        });

        app.get(`${this.basePath}/setup`, (req, res) => {
            if (!this._needsBootstrap()) return res.redirect(`${this.basePath}/login`);
            res.sendFile(path.join(__dirname, "public", "setup.html"));
        });

        app.get(`${this.basePath}/dashboard`, (req, res) => {
            if (this._needsBootstrap()) return res.redirect(`${this.basePath}/setup`);
            if (!this._isAuthed(req)) return res.redirect(`${this.basePath}/login`);
            res.sendFile(path.join(__dirname, "public", "dashboard.html"));
        });

        app.get(`${this.basePath}/config`, (req, res) => {
            if (this._needsBootstrap()) return res.redirect(`${this.basePath}/setup`);
            if (!this._isAuthed(req)) return res.redirect(`${this.basePath}/login`);
            res.sendFile(path.join(__dirname, "public", "config.html"));
        });

        app.get(`${this.basePath}/api/bootstrap/status`, (req, res) => {
            return res.json({
                ok: true,
                needsSetup: this._needsBootstrap(),
                hasUsers: this._hasConfiguredUsers(),
                sessionSecretSource: this._sessionSecretSource(),
                authSource: this._authSource()
            });
        });

        app.post(`${this.basePath}/api/bootstrap/setup`, this._jsonBody(), (req, res) => {
            if (!this._needsBootstrap()) {
                return res.status(409).json({ok: false, error: "Setup has already been completed"});
            }

            const username = this._cleanText(req.body && req.body.username, 64);
            const password = String((req.body && req.body.password) || "");
            const confirmPassword = String((req.body && req.body.confirmPassword) || "");

            const validation = this._validateBootstrapCredentials(username, password, confirmPassword);
            if (!validation.ok) {
                return res.status(400).json({ok: false, error: validation.error});
            }

            try {
                const passHash = bcrypt.hashSync(password, 10);
                this.authStore.users = [{
                    username,
                    passHash,
                    createdAt: Date.now()
                }];
                this.authStore.initializedAt = this.authStore.initializedAt || Date.now();
                this.authStore.updatedAt = Date.now();
                this._saveAuthStore();

                req.session.user = username;
                return res.json({ok: true, username});
            } catch (_) {
                return res.status(500).json({ok: false, error: "Failed to complete setup"});
            }
        });

        app.post(`${this.basePath}/api/login`, this._jsonBody(), (req, res) => {
            if (this._needsBootstrap()) {
                return res.status(409).json({ok: false, needsSetup: true, error: "Initial setup required"});
            }

            const user = (req.body && req.body.username) ? String(req.body.username) : "";
            const pass = (req.body && req.body.password) ? String(req.body.password) : "";

            const ok = this._checkLogin(user, pass);
            if (!ok) return res.status(401).json({ok: false});

            req.session.user = user;
            return res.json({ok: true});
        });

        app.post(`${this.basePath}/api/logout`, (req, res) => {
            req.session.destroy(() => res.json({ok: true}));
        });

        app.get(`${this.basePath}/api/alerts`, this._requireAuth.bind(this), (req, res) => {
            res.json({ok: true, queue: this.queue, active: this.active, activeUntil: this.activeUntil});
        });

        app.post(`${this.basePath}/api/alerts`, this._requireAuth.bind(this), this._jsonBody(), (req, res) => {
            const title = this._cleanText(req.body && req.body.title, 80) || "Alert";
            const message = this._cleanText(req.body && req.body.message, 2000);

            if (!message) return res.status(400).json({ok: false, error: "Message required"});

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

            res.json({ok: true, item});
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
            res.json({ok: true});
        });

        app.post(`${this.basePath}/api/alerts/clear`, this._requireAuth.bind(this), (req, res) => {
            this.queue = [];
            this.active = null;
            this.activeUntil = 0;
            this._saveAlerts();
            this._broadcastSync();
            this._broadcastActive();
            this.sendSocketNotification("SR_ACTION", {type: "REFRESH"});
            res.json({ok: true});
        });


        // --- Care alerts inbox (carer dashboard) ---
        app.get(`${this.basePath}/api/care-alerts`, this._requireAuth.bind(this), (req, res) => {
            const items = Array.isArray(this.careQueue) ? this.careQueue : [];
            res.json({ok: true, items});
        });

        app.post(`${this.basePath}/api/care-alerts/ack/:id`, this._requireAuth.bind(this), (req, res) => {
            const id = String(req.params.id || "");
            const now = Date.now();
            const items = Array.isArray(this.careQueue) ? this.careQueue : [];
            const idx = items.findIndex((x) => x && String(x.id) === id);
            if (idx >= 0) {
                items[idx].acknowledgedAt = now;
                items[idx].state = "acknowledged";
                this.careQueue = items;
                this._saveCareAlerts();
            }
            res.json({ok: true});
        });

        app.delete(`${this.basePath}/api/care-alerts/:id`, this._requireAuth.bind(this), (req, res) => {
            const id = String(req.params.id || "");
            const items = Array.isArray(this.careQueue) ? this.careQueue : [];
            this.careQueue = items.filter((x) => x && String(x.id) !== id);
            this._saveCareAlerts();
            res.json({ok: true});
        });

        app.post(`${this.basePath}/api/care-alerts/clear`, this._requireAuth.bind(this), (req, res) => {
            this.careQueue = [];
            this._saveCareAlerts();
            res.json({ok: true});
        });

        // --- WebRTC audio-call signalling (carer dashboard) ---

        app.post(`${this.basePath}/api/rtc/call`, this._requireAuth.bind(this), this._jsonBody(), (req, res) => {
            this._rtcPrune();
            const mode = req.body && req.body.mode ? String(req.body.mode) : "audio";
            const sdp = req.body && req.body.sdp ? req.body.sdp : null;
            if (!sdp || !sdp.type || !sdp.sdp) return res.status(400).json({ok: false, error: "bad_sdp"});

            const id = this._rtcId();
            const now = this._rtcNow();
            const session = {
                id,
                mode,
                caller: "carer",
                state: "ringing",
                device: req.body && req.body.device ? String(req.body.device) : null,
                createdAt: now,
                lastActivityAt: now,
                offer: sdp,
                answer: null,
                acceptedAt: null,
                declinedAt: null,
                endedAt: null,
                iceFromCarer: [],
                iceFromMirror: []
            };
            this._rtcPut(session);
            res.json({ok: true, sessionId: id});
        });

        app.get(`${this.basePath}/api/rtc/sessions`, this._requireAuth.bind(this), (req, res) => {
            this._rtcPrune();
            const items = Array.from(this.rtcSessions.values()).map((s) => this._rtcPublicRow(s));
            items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            res.json({ok: true, items});
        });

        app.get(`${this.basePath}/api/rtc/sessions/:id/offer`, this._requireAuth.bind(this), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s || !s.offer) return res.status(404).json({ok: false});
            res.json({ok: true, offer: s.offer});
        });

        app.get(`${this.basePath}/api/rtc/sessions/:id/answer`, this._requireAuth.bind(this), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            res.json({ok: true, answer: s.answer || null});
        });

        app.post(`${this.basePath}/api/rtc/sessions/:id/answer`, this._requireAuth.bind(this), this._jsonBody(), (req, res) => {
            const s = this._rtcGet(req.params.id);
            const ans = req.body && req.body.sdp ? req.body.sdp : null;
            if (!s) return res.status(404).json({ok: false});
            if (!ans || !ans.type || !ans.sdp) return res.status(400).json({ok: false, error: "bad_sdp"});

            s.answer = ans;
            s.state = "in_call";
            s.acceptedAt = this._rtcNow();
            s.lastActivityAt = this._rtcNow();
            this._rtcPut(s);
            res.json({ok: true});
        });

        app.get(`${this.basePath}/api/rtc/sessions/:id/ice`, this._requireAuth.bind(this), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            const since = parseInt(String(req.query.since || "0"), 10) || 0;
            const from = String(req.query.from || "mirror");
            const data = this._rtcGetIce(s, from === "carer" ? "carer" : "mirror", since);
            res.json({ok: true, items: data.items, next: data.next});
        });

        app.post(`${this.basePath}/api/rtc/sessions/:id/ice`, this._requireAuth.bind(this), this._jsonBody(), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            const c = req.body && req.body.candidate ? req.body.candidate : null;
            if (!c) return res.status(400).json({ok: false, error: "bad_candidate"});
            this._rtcAddIce(s, "carer", c);
            res.json({ok: true});
        });

        app.post(`${this.basePath}/api/rtc/sessions/:id/end`, this._requireAuth.bind(this), this._jsonBody(), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            s.endedAt = this._rtcNow();
            s.state = "ended";
            s.lastActivityAt = this._rtcNow();
            this._rtcPut(s);
            res.json({ok: true});
        });

        // --- Mirror API (token-protected) ---

        app.post(`${this.basePath}/api/mirror/care-alert`, this._requireMirrorToken.bind(this), this._jsonBody(), (req, res) => {
            const now = Date.now();
            const id = `care-${now}-${crypto.randomBytes(4).toString("hex")}`;
            const item = {
                id,
                createdAt: now,
                state: "new",
                acknowledgedAt: null,
                device: req.body && req.body.device ? String(req.body.device) : null,
                level: req.body && req.body.level ? String(req.body.level) : "help",
                message: this._cleanText(req.body && req.body.message, 1000) || "Help needed"
            };
            const items = Array.isArray(this.careQueue) ? this.careQueue : [];
            items.unshift(item);
            while (items.length > 200) items.pop();
            this.careQueue = items;
            this._saveCareAlerts();
            res.json({ok: true, id});
        });

        app.post(`${this.basePath}/api/mirror/rtc/create`, this._requireMirrorToken.bind(this), this._jsonBody(), (req, res) => {
            this._rtcPrune();
            const mode = req.body && req.body.mode ? String(req.body.mode) : "audio";
            const sdp = req.body && req.body.sdp ? req.body.sdp : null;
            if (!sdp || !sdp.type || !sdp.sdp) return res.status(400).json({ok: false, error: "bad_sdp"});

            const id = this._rtcId();
            const now = this._rtcNow();
            const session = {
                id,
                mode,
                caller: "mirror",
                state: "ringing",
                device: req.body && req.body.device ? String(req.body.device) : null,
                createdAt: now,
                lastActivityAt: now,
                offer: sdp,
                answer: null,
                acceptedAt: null,
                declinedAt: null,
                endedAt: null,
                iceFromCarer: [],
                iceFromMirror: []
            };
            this._rtcPut(session);
            res.json({ok: true, sessionId: id});
        });

        app.get(`${this.basePath}/api/mirror/rtc/pending`, this._requireMirrorToken.bind(this), (req, res) => {
            this._rtcPrune();
            const device = req.query.device ? String(req.query.device) : null;
            const items = Array.from(this.rtcSessions.values())
                .filter((s) => s && s.caller === "carer" && s.state === "ringing" && s.offer && !s.answer && !s.declinedAt && !s.endedAt)
                .filter((s) => !device || !s.device || s.device === device)
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .slice(0, 3)
                .map((s) => ({id: s.id, offer: s.offer, createdAt: s.createdAt, device: s.device || null}));
            res.json({ok: true, items});
        });

        app.get(`${this.basePath}/api/mirror/rtc/:id/answer`, this._requireMirrorToken.bind(this), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            res.json({
                ok: true,
                answer: s.answer || null,
                declinedAt: s.declinedAt || null,
                endedAt: s.endedAt || null
            });
        });

        app.post(`${this.basePath}/api/mirror/rtc/:id/answer`, this._requireMirrorToken.bind(this), this._jsonBody(), (req, res) => {
            const s = this._rtcGet(req.params.id);
            const ans = req.body && req.body.sdp ? req.body.sdp : null;
            if (!s) return res.status(404).json({ok: false});
            if (!ans || !ans.type || !ans.sdp) return res.status(400).json({ok: false, error: "bad_sdp"});

            s.answer = ans;
            s.state = "in_call";
            s.acceptedAt = this._rtcNow();
            s.lastActivityAt = this._rtcNow();
            this._rtcPut(s);
            res.json({ok: true});
        });

        app.post(`${this.basePath}/api/mirror/rtc/:id/decline`, this._requireMirrorToken.bind(this), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            s.declinedAt = this._rtcNow();
            s.state = "declined";
            s.lastActivityAt = this._rtcNow();
            this._rtcPut(s);
            res.json({ok: true});
        });

        app.get(`${this.basePath}/api/mirror/rtc/:id/ice`, this._requireMirrorToken.bind(this), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            const since = parseInt(String(req.query.since || "0"), 10) || 0;
            const from = String(req.query.from || "carer");
            const data = this._rtcGetIce(s, from === "mirror" ? "mirror" : "carer", since);
            res.json({ok: true, items: data.items, next: data.next});
        });

        app.post(`${this.basePath}/api/mirror/rtc/:id/ice`, this._requireMirrorToken.bind(this), this._jsonBody(), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            const c = req.body && req.body.candidate ? req.body.candidate : null;
            if (!c) return res.status(400).json({ok: false, error: "bad_candidate"});
            this._rtcAddIce(s, "mirror", c);
            res.json({ok: true});
        });

        app.post(`${this.basePath}/api/mirror/rtc/:id/end`, this._requireMirrorToken.bind(this), (req, res) => {
            const s = this._rtcGet(req.params.id);
            if (!s) return res.status(404).json({ok: false});
            s.endedAt = this._rtcNow();
            s.state = "ended";
            s.lastActivityAt = this._rtcNow();
            this._rtcPut(s);
            res.json({ok: true});
        });


        app.get(`${this.basePath}/api/config/modules`, this._requireAuth.bind(this), (req, res) => {
            try {
                const cfg = this._loadConfigObject(true);
                const list = (cfg.modules || []).map((m, idx) => ({
                    index: idx,
                    module: m && m.module ? m.module : null,
                    position: m && m.position ? m.position : null,
                    header: m && m.header ? m.header : null
                })).filter(x => x.module);

                res.json({ok: true, modules: list});
            } catch (_) {
                res.status(500).json({ok: false, error: "Failed to read config.js"});
            }
        });

        app.get(`${this.basePath}/api/config/module`, this._requireAuth.bind(this), (req, res) => {
            const moduleName = String(req.query.name || "");
            const index = Number(req.query.index);

            try {
                const cfg = this._loadConfigObject(true);
                const idx = this._findModuleIndex(cfg, moduleName, index);
                if (idx === -1) return res.status(404).json({ok: false, error: "Module not found"});

                const mod = cfg.modules[idx];
                res.json({ok: true, module: mod.module, index: idx, config: mod.config || {}});
            } catch (_) {
                res.status(500).json({ok: false, error: "Failed to read config.js"});
            }
        });

        app.get(`${this.basePath}/api/config/schema`, this._requireAuth.bind(this), (req, res) => {
            const moduleName = String(req.query.name || "");
            if (!moduleName) return res.status(400).json({ok: false, error: "Missing module name"});

            const out = this._loadSchema(moduleName);
            if (!out) return res.status(404).json({ok: false, error: "Schema not found"});

            return res.json({ok: true, schema: out});
        });

        app.patch(`${this.basePath}/api/config/module`, this._requireAuth.bind(this), this._jsonBody(), (req, res) => {
            const moduleName = this._cleanText(req.body && req.body.name, 80);
            const index = Number(req.body && req.body.index);
            const newConfig = req.body && req.body.config;

            if (!moduleName) return res.status(400).json({ok: false, error: "Missing module name"});
            if (!newConfig || typeof newConfig !== "object" || Array.isArray(newConfig)) {
                return res.status(400).json({ok: false, error: "config must be an object"});
            }

            const configPath = this._magicMirrorConfigPath();
            const backupPath = `${configPath}.bak`;

            try {
                this._backupFile(configPath, backupPath);

                const cfg = this._loadConfigObject(true);
                const idx = this._findModuleIndex(cfg, moduleName, index);
                if (idx === -1) return res.status(404).json({ok: false, error: "Module not found"});

                const schemaResult = this._validateSchema(moduleName, newConfig);
                if (!schemaResult.ok) {
                    this._restoreFile(backupPath, configPath);
                    return res.status(422).json({
                        ok: false,
                        error: "Schema validation failed",
                        details: schemaResult.errors
                    });
                }

                cfg.modules[idx].config = newConfig;

                this._writeConfigObject(cfg);
                this._broadcastConfigUpdated(moduleName, idx);

                res.json({ok: true});
            } catch (_) {
                try {
                    this._restoreFile(backupPath, configPath);
                } catch (_) {
                }
                res.status(500).json({ok: false, error: "Failed to update config.js"});
            }
        });

        app.post(`${this.basePath}/api/external/alert`, this._jsonBody(), (req, res) => {
            const key = process.env.SR_EXTERNAL_KEY;
            if (!key) return res.status(403).json({ok: false});

            const provided = String((req.headers["x-api-key"] || "")).trim();
            if (provided !== key) return res.status(401).json({ok: false});

            const title = this._cleanText(req.body && req.body.title, 80) || "Alert";
            const message = this._cleanText(req.body && req.body.message, 2000);
            if (!message) return res.status(400).json({ok: false, error: "Message required"});

            const item = {id: this._id(), title, message, createdAt: Date.now()};

            this.queue.push(item);
            if (this.queue.length > this.maxQueue) this.queue.shift();

            this._saveAlerts();
            this._broadcastSync();
            this._tickQueue();

            res.json({ok: true});
        });

        app.get(`${this.basePath}/api/hue/status`, this._requireAuth.bind(this), async (req, res) => {
            try {
                res.json({ok: true, ...this.hue.status()});
            } catch (e) {
                res.status(500).json({ok: false, error: e.message});
            }
        });

        app.get(`${this.basePath}/api/hue/items`, this._requireAuth.bind(this), async (req, res) => {
            try {
                const type = String(req.query.type || "light");
                const out = await this.hue.getItems(type);
                res.json({ok: true, type, items: out.items || [], updatedAt: out.ts || 0});
            } catch (e) {
                res.status(500).json({ok: false, error: e.message});
            }
        });

        app.put(`${this.basePath}/api/hue/items/:id`, this._requireAuth.bind(this), this._jsonBody(), async (req, res) => {
            try {
                await this.hue.setState({
                    type: String((req.body && req.body.type) || "light"),
                    id: String(req.params.id || ""),
                    on: typeof (req.body && req.body.on) === "boolean" ? req.body.on : undefined,
                    rgb: req.body && req.body.rgb ? String(req.body.rgb) : undefined,
                    briPct: Number.isFinite(Number(req.body && req.body.briPct)) ? Number(req.body.briPct) : undefined
                });
                res.json({ok: true});
            } catch (e) {
                res.status(500).json({ok: false, error: e.message});
            }
        });

        app.post(`${this.basePath}/api/hue/command`, this._requireAuth.bind(this), this._jsonBody(), async (req, res) => {
            try {
                const text = String((req.body && req.body.text) || "");
                const type = String((req.body && req.body.type) || "light");
                await this.hue.executeTextCommand(text, type);
                res.json({ok: true});
            } catch (e) {
                res.status(400).json({ok: false, error: e.message});
            }
        });
    },

    _requireAuth(req, res, next) {
        if (this._needsBootstrap()) return res.status(409).json({
            ok: false,
            needsSetup: true,
            error: "Initial setup required"
        });
        if (!this._isAuthed(req)) return res.status(401).json({ok: false});
        next();
    },

    _isAuthed(req) {
        return !!(req.session && req.session.user);
    },

    _checkLogin(username, password) {
        const u = String(username || "");
        const users = this._getConfiguredUsers();
        if (!Array.isArray(users) || !users.length) return false;

        const match = users.find(x => x && x.username === u && typeof x.passHash === "string");
        if (!match) return false;
        return bcrypt.compareSync(password, match.passHash);
    },

    _getConfiguredUsers() {
        const usersJson = process.env.SR_USERS_JSON;
        if (usersJson) {
            try {
                const users = JSON.parse(usersJson);
                if (Array.isArray(users)) {
                    return users.filter(x => x && typeof x.username === "string" && typeof x.passHash === "string");
                }
            } catch (_) {
                return [];
            }
        }

        const expectedUser = process.env.SR_ADMIN_USER || "";
        const passHash = process.env.SR_ADMIN_PASS_HASH || "";
        if (expectedUser && passHash) {
            return [{username: expectedUser, passHash}];
        }

        const fileUsers = Array.isArray(this.authStore && this.authStore.users) ? this.authStore.users : [];
        return fileUsers.filter(x => x && typeof x.username === "string" && typeof x.passHash === "string");
    },

    _hasConfiguredUsers() {
        return this._getConfiguredUsers().length > 0;
    },

    _needsBootstrap() {
        return !this._hasConfiguredUsers();
    },

    _getSessionSecret() {
        const envSecret = process.env.SR_SESSION_SECRET;
        if (envSecret && envSecret.length >= 24) return envSecret;
        return this.authStore.sessionSecret;
    },

    _sessionSecretSource() {
        const envSecret = process.env.SR_SESSION_SECRET;
        return envSecret && envSecret.length >= 24 ? "env" : "file";
    },

    _authSource() {
        if (process.env.SR_USERS_JSON) return "env_users_json";
        if (process.env.SR_ADMIN_USER && process.env.SR_ADMIN_PASS_HASH) return "env_single_user";
        return "file";
    },

    _loadOrCreateAuthStore() {
        const fallback = {
            sessionSecret: this._generateSessionSecret(),
            users: [],
            initializedAt: Date.now(),
            updatedAt: Date.now()
        };

        try {
            if (fs.existsSync(this.authFile)) {
                const raw = fs.readFileSync(this.authFile, "utf8");
                const parsed = JSON.parse(raw);
                const out = {
                    sessionSecret: (parsed && typeof parsed.sessionSecret === "string" && parsed.sessionSecret.length >= 24)
                        ? parsed.sessionSecret
                        : fallback.sessionSecret,
                    users: Array.isArray(parsed && parsed.users) ? parsed.users : [],
                    initializedAt: parsed && parsed.initializedAt ? parsed.initializedAt : Date.now(),
                    updatedAt: Date.now()
                };
                const needsRewrite = !parsed || out.sessionSecret !== parsed.sessionSecret || !Array.isArray(parsed.users);
                if (needsRewrite) {
                    this.authStore = out;
                    this._saveAuthStore();
                }
                return out;
            }
        } catch (_) {
        }

        try {
            fs.writeFileSync(this.authFile, JSON.stringify(fallback, null, 2), {encoding: "utf8", mode: 0o600});
        } catch (_) {
        }
        return fallback;
    },

    _saveAuthStore() {
        const payload = JSON.stringify(this.authStore, null, 2);
        fs.writeFileSync(this.authFile, payload, {encoding: "utf8", mode: 0o600});
    },

    _generateSessionSecret() {
        return crypto.randomBytes(48).toString("base64url");
    },

    _validateBootstrapCredentials(username, password, confirmPassword) {
        if (!username) return {ok: false, error: "Username is required"};
        if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
            return {
                ok: false,
                error: "Username must be 3-64 characters and use letters, numbers, dot, dash or underscore"
            };
        }
        if (!password || password.length < 8) {
            return {ok: false, error: "Password must be at least 8 characters"};
        }
        if (password !== confirmPassword) {
            return {ok: false, error: "Passwords do not match"};
        }
        return {ok: true};
    },

    _static(dir) {
        return require("express").static(dir, {maxAge: "1h"});
    },

    _jsonBody() {
        const express = require("express");
        return express.json({limit: "256kb"});
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
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
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
        } catch (_) {
        }
    },

    _broadcastSync() {
        this.sendSocketNotification("SR_ALERTS_SYNC", {queue: this.queue});
    },

    _broadcastActive() {
        this.sendSocketNotification("SR_ACTIVE_CHANGED", {active: this.active, activeUntil: this.activeUntil});
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
        if (!fs.existsSync(schemaPath)) return {ok: true};

        try {
            const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
            const ajv = new Ajv({allErrors: true, strict: false});
            const validate = ajv.compile(schema);
            const ok = validate(moduleConfig);
            if (ok) return {ok: true};
            return {ok: false, errors: validate.errors || []};
        } catch (_) {
            return {ok: false, errors: [{message: "Schema file could not be used"}]};
        }
    },

    _loadSchema(moduleName) {
        const schemaPath = path.join(__dirname, "schemas", `${moduleName}.schema.json`);
        if (!fs.existsSync(schemaPath)) return null;

        try {
            return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
        } catch (_) {
            return null;
        }
    },

    _broadcastConfigUpdated(moduleName, index) {
        this.sendSocketNotification("SR_ACTION", {type: "REFRESH"});
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
            acks.push({id: String(id), acknowledgedAt: Date.now()});
            fs.writeFileSync(ackFile, JSON.stringify(acks, null, 2), "utf8");
        } catch (_) {
        }
    },


    // --- Care alerts (from mirror) ---

    _loadCareAlerts() {
        try {
            if (!fs.existsSync(this.careFile)) return [];
            const raw = fs.readFileSync(this.careFile, "utf-8");
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : [];
        } catch (_) {
            return [];
        }
    },

    _saveCareAlerts() {
        try {
            fs.writeFileSync(this.careFile, JSON.stringify(this.careQueue || [], null, 2), "utf-8");
        } catch (_) {
        }
    },

    _requireMirrorToken(req, res, next) {
        const expected = String(this.mirrorToken || "").trim();
        if (!expected) return res.status(403).json({ok: false, error: "mirror_token_not_configured"});

        const provided = String(req.headers["x-mirror-token"] || "").trim();
        if (!provided || provided !== expected) return res.status(401).json({ok: false, error: "bad_mirror_token"});

        return next();
    },

    // --- WebRTC signalling store ---

    _rtcNow() {
        return Date.now();
    },

    _rtcId() {
        this.rtcSeq += 1;
        const rand = crypto.randomBytes(6).toString("hex");
        return `rtc-${this.rtcSeq}-${rand}`;
    },

    _rtcGet(id) {
        return this.rtcSessions.get(String(id)) || null;
    },

    _rtcPut(session) {
        if (!session || !session.id) return;
        this.rtcSessions.set(String(session.id), session);
    },

    _rtcPrune() {
        const now = this._rtcNow();
        const ttlActive = 45 * 60 * 1000;
        const ttlEnded = 5 * 60 * 1000;

        for (const [id, s] of this.rtcSessions.entries()) {
            const ended = s.endedAt || s.declinedAt;
            const age = now - (s.lastActivityAt || s.createdAt || now);
            const endedAge = ended ? (now - ended) : 0;

            if (ended && endedAge > ttlEnded) {
                this.rtcSessions.delete(id);
                continue;
            }
            if (!ended && age > ttlActive) {
                s.endedAt = now;
                s.state = "ended";
                this.rtcSessions.set(id, s);
            }
        }
    },

    _rtcPublicRow(s) {
        return {
            id: s.id,
            mode: s.mode,
            caller: s.caller,
            state: s.state,
            device: s.device || null,
            createdAt: s.createdAt,
            acceptedAt: s.acceptedAt || null,
            declinedAt: s.declinedAt || null,
            endedAt: s.endedAt || null,
            hasOffer: !!s.offer,
            hasAnswer: !!s.answer
        };
    },

    _rtcAddIce(session, from, candidate) {
        if (!session) return;
        const arrName = from === "mirror" ? "iceFromMirror" : "iceFromCarer";
        if (!Array.isArray(session[arrName])) session[arrName] = [];
        const idx = session[arrName].length ? (session[arrName][session[arrName].length - 1].idx + 1) : 1;
        session[arrName].push({idx, ts: this._rtcNow(), candidate});
        while (session[arrName].length > 500) session[arrName].shift();
        session.lastActivityAt = this._rtcNow();
        this._rtcPut(session);
    },

    _rtcGetIce(session, from, sinceIdx) {
        const arrName = from === "mirror" ? "iceFromMirror" : "iceFromCarer";
        const arr = Array.isArray(session[arrName]) ? session[arrName] : [];
        const since = Number.isFinite(sinceIdx) ? sinceIdx : 0;
        const items = arr.filter((x) => x && x.idx > since).map((x) => ({idx: x.idx, candidate: x.candidate}));
        const next = arr.length ? arr[arr.length - 1].idx : since;
        return {items, next};
    },

});