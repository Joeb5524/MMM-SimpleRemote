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
            hue: this.config.hue,
            mirrorToken: this.config.mirrorToken
        });
    },

    getStyles() {
        return ["MMM-SimpleRemote.css"];
    },

    notificationReceived(notification) {
        if (notification === "SR_ACK_ACTIVE_REQUEST") {
            if (!this.active || !this.active.id) return;
            this.sendSocketNotification("SR_ACK_ACTIVE", {id: this.active.id});
            return;
        }

        if (notification === "SR_DISMISS_ACTIVE_REQUEST") {
            this.sendSocketNotification("SR_DISMISS_ACTIVE", {});
        }
    },

    getDom() {
        const wrapper = document.createElement("div");
        wrapper.className = this.config.dismissOnTouch ? "sr-root sr-root--dismissable" : "sr-root";
        wrapper.setAttribute("aria-live", "assertive");

        if (!this.active) {
            wrapper.style.display = "none";
            return wrapper;
        }

        const card = document.createElement("div");
        card.className = "sr-card";
        card.setAttribute("role", "alert");

        const header = document.createElement("div");
        header.className = "sr-header";

        const badge = document.createElement("div");
        badge.className = "sr-badge";
        badge.textContent = "Remote alert";
        header.appendChild(badge);

        if (this.config.showTimestamp && this.active.createdAt) {
            const meta = document.createElement("div");
            meta.className = "sr-meta dimmed";
            meta.textContent = this._formatTimestamp(this.active.createdAt);
            header.appendChild(meta);
        }

        const title = document.createElement("div");
        title.className = "sr-title bright";
        title.textContent = this.active.title || "Alert";

        const body = document.createElement("div");
        body.className = "sr-body normal";
        body.textContent = this.active.message || "";

        card.appendChild(header);
        card.appendChild(title);
        card.appendChild(body);

        if (this.config.dismissOnTouch) {
            const hint = document.createElement("div");
            hint.className = "sr-hint dimmed";
            hint.textContent = "Tap anywhere to dismiss";
            card.appendChild(hint);
        }

        wrapper.appendChild(card);

        if (this.config.dismissOnTouch) {
            wrapper.onclick = () => {
                if (!this.active || !this.active.id) return;
                this.sendSocketNotification("SR_ACK_ACTIVE", {id: this.active.id});
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
    },

    _formatTimestamp(value) {
        const date = new Date(value);

        if (Number.isNaN(date.getTime())) return "";

        return date.toLocaleString([], {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
        });
    }
});
