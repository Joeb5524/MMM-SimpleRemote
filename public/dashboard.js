const sent = document.getElementById("sent");
const sendErr = document.getElementById("sendErr");

document.getElementById("logout").onclick = async () => {
    await window.srFetch("/api/logout", { method: "POST" });
    window.location.href = `${window.SR_BASE}/login`;
};

document.getElementById("send").onclick = async () => {
    sent.style.display = "none";
    sendErr.style.display = "none";

    const title = document.getElementById("title").value.trim();
    const message = document.getElementById("message").value;

    const res = await window.srFetch("/api/alerts", {
        method: "POST",
        body: JSON.stringify({ title, message })
    });

    if (res && res.ok && res.json && res.json.ok) {
        sent.style.display = "block";
        document.getElementById("message").value = "";
        await refreshAlerts();
    } else {
        sendErr.style.display = "block";
    }
};

document.getElementById("clear").onclick = async () => {
    await window.srFetch("/api/alerts/clear", { method: "POST" });
    await refreshAlerts();
};

async function refreshAlerts() {
    const res = await window.srFetch("/api/alerts", { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    const q = document.getElementById("queue");
    q.innerHTML = "";

    const queue = res.json.queue || [];
    queue.forEach(item => q.appendChild(renderAlertRow(item)));
}

function renderAlertRow(item) {
    const row = document.createElement("div");
    row.className = "sr-row";

    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "sr-row-title";
    t.textContent = item.title || "Alert";

    const m = document.createElement("div");
    m.className = "sr-row-msg";
    m.textContent = item.message || "";

    const meta = document.createElement("div");
    meta.className = "sr-chip";
    meta.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";

    left.appendChild(t);
    left.appendChild(m);
    left.appendChild(meta);

    const del = document.createElement("button");
    del.className = "button is-small is-light";
    del.textContent = "Delete";
    del.onclick = async () => {
        await window.srFetch(`/api/alerts/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        await refreshAlerts();
    };

    row.appendChild(left);
    row.appendChild(del);
    return row;
}



const hueStatusEl = document.getElementById("hueStatus");
const hueErrEl = document.getElementById("hueErr");
const hueListEl = document.getElementById("hueList");

const btnLights = document.getElementById("hueTypeLights");
const btnGroups = document.getElementById("hueTypeGroups");
const btnMic = document.getElementById("hueMic");

let hueType = "light";
let hueItems = [];
const pending = new Map();

btnLights.onclick = () => setHueType("light");
btnGroups.onclick = () => setHueType("grouped_light");

function setHueType(t) {
    hueType = t;
    refreshHue();
}

function setHueError(msg) {
    if (!msg) {
        hueErrEl.style.display = "none";
        hueErrEl.textContent = "";
        return;
    }
    hueErrEl.style.display = "block";
    hueErrEl.textContent = msg;
}

async function refreshHueStatus() {
    const res = await window.srFetch("/api/hue/status", { method: "GET" });
    if (!res || !res.ok || !res.json) {
        hueStatusEl.textContent = "Unavailable";
        hueStatusEl.className = "tag is-danger is-light level-item";
        return;
    }

    if (!res.json.configured) {
        hueStatusEl.textContent = "Not configured";
        hueStatusEl.className = "tag is-warning is-light level-item";
        return;
    }

    hueStatusEl.textContent = `OK (${String(res.json.api || "").toUpperCase()})`;
    hueStatusEl.className = "tag is-success is-light level-item";
}

async function refreshHue() {
    setHueError(null);

    const res = await window.srFetch(`/api/hue/items?type=${encodeURIComponent(hueType)}`, { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    if (!res.json.ok) {
        setHueError(res.json.error || "Hue error");
        return;
    }

    hueItems = Array.isArray(res.json.items) ? res.json.items : [];
    renderHueList();
}

function effectiveOn(item) {
    const p = pending.get(item.id);
    if (!p) return !!item.on;
    if (Date.now() - p.startedAt > 3500) {
        pending.delete(item.id);
        return !!item.on;
    }
    return !!p.desiredOn;
}

function effectiveHex(item) {
    const p = pending.get(item.id);
    if (p && p.desiredHex) return p.desiredHex;
    return rgbCssToHex(item.rgb) || "#ffffff";
}

function renderHueList() {
    hueListEl.innerHTML = "";
    if (!hueItems.length) {
        hueListEl.textContent = "No Hue items.";
        return;
    }

    for (const item of hueItems) {
        const card = document.createElement("div");
        card.className = "sr-hue-card";

        const isPending = pending.has(item.id);
        if (isPending) card.classList.add("is-pending");

        const title = document.createElement("div");
        title.className = "sr-hue-title";

        const name = document.createElement("div");
        name.textContent = item.name || item.id;

        const stateTag = document.createElement("span");
        stateTag.className = `tag ${effectiveOn(item) ? "is-success" : "is-light"}`;
        stateTag.textContent = item.reachable === false ? "Offline" : (effectiveOn(item) ? "On" : "Off");

        title.appendChild(name);
        title.appendChild(stateTag);

        const meta = document.createElement("div");
        meta.className = "sr-hue-meta";

        const dot = document.createElement("span");
        dot.className = "sr-hue-dot";
        dot.style.background = effectiveOn(item) && item.rgb ? item.rgb : "transparent";

        const type = document.createElement("span");
        type.textContent = hueType === "grouped_light" ? "Room/Zone" : "Light";

        meta.appendChild(dot);
        meta.appendChild(type);

        const controls = document.createElement("div");
        controls.className = "sr-hue-controls";

        const left = document.createElement("div");
        left.style.display = "flex";
        left.style.alignItems = "center";
        left.style.gap = "10px";

        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = effectiveHex(item);
        picker.title = "Set colour";
        picker.onclick = (e) => e.stopPropagation();
        picker.onchange = async (e) => {
            e.stopPropagation();
            await setHueColour(item, picker.value);
        };

        const bri = document.createElement("input");
        bri.type = "range";
        bri.min = "1";
        bri.max = "100";
        bri.value = "100";
        bri.title = "Brightness";
        bri.onclick = (e) => e.stopPropagation();

        const applyBri = debounce(async () => {
            await setHueBrightness(item, Number(bri.value));
        }, 200);

        bri.oninput = (e) => {
            e.stopPropagation();
            applyBri();
        };

        left.appendChild(picker);
        left.appendChild(bri);

        const toggleBtn = document.createElement("button");
        toggleBtn.className = "button is-small is-link is-light";
        toggleBtn.textContent = effectiveOn(item) ? "Turn off" : "Turn on";
        toggleBtn.onclick = async (e) => {
            e.stopPropagation();
            await toggleHue(item);
        };

        controls.appendChild(left);
        controls.appendChild(toggleBtn);

        card.appendChild(title);
        card.appendChild(meta);
        card.appendChild(controls);

        card.onclick = async () => {
            await toggleHue(item);
        };

        hueListEl.appendChild(card);
    }
}

async function toggleHue(item) {
    if (item.reachable === false) return;

    const now = Date.now();
    const p = pending.get(item.id);
    if (p && now - p.startedAt < 350) return;

    const desiredOn = !effectiveOn(item);
    pending.set(item.id, { startedAt: now, desiredOn });
    renderHueList();

    const res = await window.srFetch(`/api/hue/items/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        body: JSON.stringify({ type: hueType, on: desiredOn })
    });

    if (!res || !res.ok || !res.json || !res.json.ok) {
        pending.delete(item.id);
        renderHueList();
        setHueError((res && res.json && res.json.error) ? res.json.error : "Failed to toggle");
    } else {
        setHueError(null);
    }
}

async function setHueColour(item, hex) {
    const now = Date.now();
    pending.set(item.id, { startedAt: now, desiredOn: true, desiredHex: hex });
    renderHueList();

    const res = await window.srFetch(`/api/hue/items/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        body: JSON.stringify({ type: hueType, rgb: hex, on: true })
    });

    if (!res || !res.ok || !res.json || !res.json.ok) {
        pending.delete(item.id);
        renderHueList();
        setHueError((res && res.json && res.json.error) ? res.json.error : "Failed to set colour");
    } else {
        setHueError(null);
    }
}

async function setHueBrightness(item, briPct) {
    const res = await window.srFetch(`/api/hue/items/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        body: JSON.stringify({ type: hueType, briPct: briPct, on: effectiveOn(item) })
    });

    if (!res || !res.ok || !res.json || !res.json.ok) {
        setHueError((res && res.json && res.json.error) ? res.json.error : "Failed to set brightness");
    } else {
        setHueError(null);
    }
}

function rgbCssToHex(rgb) {
    if (!rgb) return null;
    const m = String(rgb).match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (!m) return null;
    const r = clamp8(m[1]), g = clamp8(m[2]), b = clamp8(m[3]);
    const n = (r << 16) | (g << 8) | b;
    return "#" + n.toString(16).padStart(6, "0");
}

function clamp8(n) {
    return Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
}

function debounce(fn, ms) {
    let t = null;
    return function () {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn.apply(null, arguments), ms);
    };
}



let es = null;

function attachHueStream() {
    if (es) {
        try { es.close(); } catch (_) {}
        es = null;
    }

    es = new EventSource(`${window.SR_BASE}/api/hue/stream`);

    es.addEventListener("status", () => refreshHueStatus().catch(() => {}));
    es.addEventListener("hue", (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg && msg.type === hueType && Array.isArray(msg.items)) {
                hueItems = msg.items;
                renderHueList();
            }
        } catch (_) {}
    });

    es.onerror = () => {
        // If SSE fails, polling still keeps things usable
    };
}



btnMic.onclick = async () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        setHueError("SpeechRecognition not supported in this browser.");
        return;
    }

    setHueError(null);

    const rec = new SpeechRecognition();
    rec.lang = "en-GB";
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = async (e) => {
        const text = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : "";
        if (!text) return;

        const res = await window.srFetch("/api/hue/command", {
            method: "POST",
            body: JSON.stringify({ text, type: hueType })
        });

        if (!res || !res.ok || !res.json || !res.json.ok) {
            setHueError((res && res.json && res.json.error) ? res.json.error : "Voice command failed");
        } else {
            setHueError(null);
        }
    };

    rec.onerror = () => setHueError("Voice error or permission denied.");
    rec.start();
};


async function bootstrap() {
    await refreshAlerts();
    await refreshHueStatus();
    await refreshHue();
    attachHueStream();
    setInterval(refreshAlerts, 4000);
    setInterval(refreshHue, 6000);
}

bootstrap().catch(() => {});
