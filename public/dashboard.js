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

btnLights.onclick = async () => {
    hueType = "light";
    await refreshHue();
};

btnGroups.onclick = async () => {
    hueType = "grouped_light";
    await refreshHue();
};

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
    if (!res || !res.ok || !res.json) return;

    if (!res.json.configured) {
        hueStatusEl.textContent = "Not configured";
        hueStatusEl.className = "tag is-warning is-light level-item";
        return;
    }

    hueStatusEl.textContent = `OK (${String(res.json.api || "").toUpperCase()})`;
    hueStatusEl.className = "tag is-success is-light level-item";
}

async function refreshHue() {
    const res = await window.srFetch(`/api/hue/items?type=${encodeURIComponent(hueType)}`, { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    if (!res.json.ok) {
        setHueError(res.json.error || "Hue error");
        return;
    }

    setHueError(null);
    hueItems = Array.isArray(res.json.items) ? res.json.items : [];
    renderHueList();
}

function effectiveOn(item) {
    const p = pending.get(item.id);
    if (!p) return !!item.on;
    if (Date.now() - p.startedAt > 3000) {
        pending.delete(item.id);
        return !!item.on;
    }
    return !!p.desiredOn;
}

function rgbCssToHex(rgb) {
    if (!rgb) return "#ffffff";
    const m = String(rgb).match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (!m) return "#ffffff";

    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);

    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
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
        if (pending.has(item.id)) card.classList.add("is-pending");

        const title = document.createElement("div");
        title.className = "sr-hue-title";

        const name = document.createElement("div");
        name.textContent = item.name || item.id;

        const state = document.createElement("span");
        state.className = `tag ${effectiveOn(item) ? "is-success" : "is-light"}`;
        state.textContent = effectiveOn(item) ? "On" : "Off";

        title.appendChild(name);
        title.appendChild(state);

        const meta = document.createElement("div");
        meta.className = "sr-hue-meta";

        const dot = document.createElement("span");
        dot.className = "sr-hue-dot";
        dot.style.background = effectiveOn(item) && item.rgb ? item.rgb : "transparent";

        const typeLabel = document.createElement("span");
        typeLabel.textContent = hueType === "grouped_light" ? "Room/Zone" : "Light";

        meta.appendChild(dot);
        meta.appendChild(typeLabel);

        const controls = document.createElement("div");
        controls.className = "sr-hue-controls";

        const left = document.createElement("div");
        left.className = "sr-hue-controls-left";

        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = rgbCssToHex(item.rgb);
        picker.onclick = (e) => e.stopPropagation();
        picker.onchange = async (e) => {
            e.stopPropagation();
            await setHueColour(item, picker.value);
        };

        const range = document.createElement("input");
        range.type = "range";
        range.min = "1";
        range.max = "100";
        range.value = "100";
        range.onclick = (e) => e.stopPropagation();
        range.onchange = async (e) => {
            e.stopPropagation();
            await setHueBrightness(item, Number(range.value));
        };

        left.appendChild(picker);
        left.appendChild(range);

        const toggle = document.createElement("button");
        toggle.className = "button is-small is-light";
        toggle.textContent = effectiveOn(item) ? "Turn off" : "Turn on";
        toggle.onclick = async (e) => {
            e.stopPropagation();
            await toggleHue(item);
        };

        controls.appendChild(left);
        controls.appendChild(toggle);

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
    const desiredOn = !effectiveOn(item);
    pending.set(item.id, { startedAt: Date.now(), desiredOn });
    renderHueList();

    const res = await window.srFetch(`/api/hue/items/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        body: JSON.stringify({ type: hueType, on: desiredOn })
    });

    pending.delete(item.id);

    if (!res || !res.ok || !res.json || !res.json.ok) {
        setHueError((res && res.json && res.json.error) ? res.json.error : "Failed to toggle Hue item");
    } else {
        setHueError(null);
        await refreshHue();
    }
}

async function setHueColour(item, hex) {
    pending.set(item.id, { startedAt: Date.now(), desiredOn: true, desiredHex: hex });
    renderHueList();

    const res = await window.srFetch(`/api/hue/items/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        body: JSON.stringify({ type: hueType, on: true, rgb: hex })
    });

    pending.delete(item.id);

    if (!res || !res.ok || !res.json || !res.json.ok) {
        setHueError((res && res.json && res.json.error) ? res.json.error : "Failed to set colour");
    } else {
        setHueError(null);
        await refreshHue();
    }
}

async function setHueBrightness(item, briPct) {
    const res = await window.srFetch(`/api/hue/items/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        body: JSON.stringify({ type: hueType, on: effectiveOn(item), briPct })
    });

    if (!res || !res.ok || !res.json || !res.json.ok) {
        setHueError((res && res.json && res.json.error) ? res.json.error : "Failed to set brightness");
    } else {
        setHueError(null);
        await refreshHue();
    }
}

btnMic.onclick = async () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        setHueError("Speech recognition is not supported in this browser.");
        return;
    }

    const rec = new SpeechRecognition();
    rec.lang = "en-GB";
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = async (event) => {
        const text = event.results && event.results[0] && event.results[0][0]
            ? event.results[0][0].transcript
            : "";

        if (!text) return;

        const res = await window.srFetch("/api/hue/command", {
            method: "POST",
            body: JSON.stringify({ text, type: hueType })
        });

        if (!res || !res.ok || !res.json || !res.json.ok) {
            setHueError((res && res.json && res.json.error) ? res.json.error : "Voice command failed");
        } else {
            setHueError(null);
            await refreshHue();
        }
    };

    rec.onerror = () => setHueError("Voice recognition failed.");
    rec.start();
};

async function init() {
    await refreshAlerts();
    await refreshHueStatus();
    await refreshHue();
}

init();
setInterval(refreshAlerts, 4000);
setInterval(refreshHue, 6000);