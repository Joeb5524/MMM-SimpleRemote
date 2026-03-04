/* global Module, Log */

Module.register("MMM-SimpleRemote", {
    defaults: {
        basePath: "/mm-simple-remote",
        maxQueue: 25,
        showTimestamp: true,
        dismissOnTouch: true
    },

    start() {
        Log.info(`[MMM-SimpleRemote] starting (${this.config.basePath})`);

        this.queue = [];
        this.active = null;

        this.sendSocketNotification("SR_INIT", {
            basePath: this.config.basePath,
            maxQueue: this.config.maxQueue
        });
    },

    getStyles() {
        return ["MMM-SimpleRemote.css"];
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
            const d = new Date(this.active.createdAt);
            meta.textContent = d.toLocaleString();
        }

        card.appendChild(title);
        card.appendChild(body);
        card.appendChild(meta);
        wrapper.appendChild(card);

        if (this.config.dismissOnTouch) {
            wrapper.onclick = () => {
                if (!this.active || !this.active.id) return;

                this.sendNotification("REMOTE_ALERT_ACK", {
                    alertId: this.active.id,
                    acknowledgedAt: Date.now()
                });

                this.sendSocketNotification("SR_ACK_ACTIVE", {
                    id: this.active.id
                });

                this.dismissActive();
            };
        }

        return wrapper;
    },

    notificationReceived(notification, payload) {

        if (notification === "SR_SHOW_ALERT" && payload) {
            this.enqueue(payload);
            return;
        }

        if (notification === "SR_CLEAR_ALERTS") {
            this.queue = [];
            this.active = null;
            this.updateDom(0);
            return;
        }

        if (
            notification === "SR_ACK_ACTIVE_REQUEST" ||
            notification === "SR_DISMISS_ACTIVE_REQUEST"
        ) {
            this.sendSocketNotification("SR_DISMISS_ACTIVE", {});
            this.dismissActive();
            return;
        }
    },

    socketNotificationReceived(notification, payload) {

        if (notification === "SR_ALERTS_SYNC") {
            this.queue = Array.isArray(payload.queue) ? payload.queue : [];

            if (!this.active) {
                this.showNext();
            }

            return;
        }

        if (notification === "SR_ACTIVE_CHANGED") {
            this.active = payload && payload.active ? payload.active : null;
            this.updateDom(0);
            return;
        }

        if (notification === "SR_ACTION") {
            if (payload && payload.type === "REFRESH") {
                window.location.reload();
            }
        }
    },

    enqueue(alert) {
        this.queue.push(alert);

        if (this.queue.length > this.config.maxQueue) {
            this.queue.shift();
        }

        if (!this.active) {
            this.showNext();
        }
    },

    showNext() {
        if (!this.queue.length) {
            this.active = null;
            this.updateDom(0);
            return;
        }

        this.active = this.queue.shift();
        this.updateDom(0);

        if (this.active && this.active.id) {
            this.sendNotification("REMOTE_ALERT_SENT", {
                alertId: this.active.id,
                title: this.active.title,
                message: this.active.message,
                createdAt: this.active.createdAt
            });
        }
    },

    dismissActive() {
        this.active = null;
        this.showNext();
    }
});