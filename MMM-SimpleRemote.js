/* global Module, Log */

Module.register("MMM-SimpleRemote", {
    defaults: {
        basePath: "/mm-simple-remote",
        maxQueue: 25,
        showTimestamp: true,
        dismissOnTouch: true,

        hue: {
            enabled: false,
            apiVersion: "auto",
            bridgeIp: "",
            hueApplicationKey: "",
            userId: "",
            insecureSkipVerify: true,
            pollIntervalMs: 15000,
            enableEventStream: true
        }
    },

    start() {
        Log.info(`[MMM-SimpleRemote] starting (${this.config.basePath})`);

        this.queue = [];
        this.active = null;
        this._lastActiveId = null;

        this.sendSocketNotification("SR_INIT", {
            basePath: this.config.basePath,
            maxQueue: this.config.maxQueue,
            hue: this.config.hue
        });
    },

    getStyles() {
        return ["MMM-SimpleRemote.css"];
    },

    notificationReceived(notification, payload) {
        if (notification === "SR_ACK_ACTIVE_REQUEST") {
            if (!this.active || !this.active.id) return;
            this.sendSocketNotification("SR_ACK_ACTIVE", { id: this.active.id });
            return;
        }

        if (notification === "SR_DISMISS_ACTIVE_REQUEST") {
            this.sendSocketNotification("SR_DISMISS_ACTIVE", {});
            return;
        }

        if (notification === "SR_CARE_ALERT") {
            const title = payload && typeof payload.title === "string" ? payload.title : "Mirror alert";
            const message = payload && typeof payload.message === "string"
                ? payload.message
                : "Assistance requested from the mirror.";

            this.sendSocketNotification("SR_CARE_ALERT_CREATE", {
                title,
                message,
                level: payload && payload.level ? String(payload.level) : "help",
                requestId: payload && payload.requestId ? String(payload.requestId) : null
            });

            this.sendNotification("SR_CARE_ALERT_SENT", { title, message, at: Date.now() });
        }
    },

    getDom() {
        const wrapper = document.createElement("div");
        wrapper.className = "sr-root";

        if (!this.active) {
            wrapper.style.display = "none";
            return wrapper;
        }

        const card = document.createElement("div");
        card.className = "sr-card";

        const title = document.createElement("div");
        title.className = "sr-title";
        title.textContent = this.active.title || "Alert";

        const body = document.createElement("div");
        body.className = "sr-body";
        body.textContent = this.active.message || "";

        const meta = document.createElement("div");
        meta.className = "sr-meta";

        if (this.config.showTimestamp && this.active.createdAt) {
            meta.textContent = new Date(this.active.createdAt).toLocaleString();
        }

        card.appendChild(title);
        card.appendChild(body);
        card.appendChild(meta);
        wrapper.appendChild(card);

        if (this.config.dismissOnTouch) {
            wrapper.onclick = () => {
                if (!this.active || !this.active.id) return;
                this.sendSocketNotification("SR_ACK_ACTIVE", { id: this.active.id });
                this.active = null;
                this.updateDom(0);
            };
        }

        return wrapper;
    },

    socketNotificationReceived(notification, payload) {
        if (notification === "SR_ALERTS_SYNC") {
            this.queue = Array.isArray(payload.queue) ? payload.queue : [];
            if (!this.active && this.queue.length) this.active = this.queue.shift();
            this._syncAlertNotifications();
            this.updateDom(0);
            return;
        }

        if (notification === "SR_ACTIVE_CHANGED") {
            this.active = payload && payload.active ? payload.active : null;
            this._syncAlertNotifications();
            this.updateDom(0);
            return;
        }

        if (notification === "SR_CARE_ALERT_CREATED" && payload && payload.item) {
            this.sendNotification("SR_CARE_ALERT_STORED", {
                item: payload.item,
                requestId: payload.requestId || null
            });
        }
    },

    _syncAlertNotifications() {
        const currentId = this.active && this.active.id ? String(this.active.id) : null;

        if (currentId && currentId !== this._lastActiveId) {
            this.sendNotification("REMOTE_ALERT_SENT", {
                alertId: currentId,
                active: this.active
            });
        }

        if (!currentId && this._lastActiveId) {
            this.sendNotification("REMOTE_ALERT_ACK", {
                alertId: this._lastActiveId
            });
            this.sendNotification("REMOTE_ALERT_CLEARED", {
                alertId: this._lastActiveId
            });
        }

        this._lastActiveId = currentId;
    }
});