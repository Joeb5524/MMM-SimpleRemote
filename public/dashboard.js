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

    const queue = Array.isArray(res.json.queue) ? res.json.queue : [];
    if (!queue.length) {
        const empty = document.createElement("p");
        empty.className = "sr-empty-state";
        empty.textContent = "No alerts in the queue.";
        q.appendChild(empty);
        return;
    }

    queue.forEach((item) => q.appendChild(renderAlertRow(item)));
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
    updateHueTypeButtons();
    await refreshHue();
};

btnGroups.onclick = async () => {
    hueType = "grouped_light";
    updateHueTypeButtons();
    await refreshHue();
};

function updateHueTypeButtons() {
    btnLights.classList.toggle("is-selected", hueType === "light");
    btnGroups.classList.toggle("is-selected", hueType === "grouped_light");
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
    if (!res || !res.ok || !res.json) return;

    if (!res.json.configured) {
        hueStatusEl.textContent = "Not configured";
        hueStatusEl.className = "tag is-warning is-light";
        return;
    }

    hueStatusEl.textContent = `OK (${String(res.json.api || "").toUpperCase()})`;
    hueStatusEl.className = "tag is-success is-light";
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
        const empty = document.createElement("p");
        empty.className = "sr-empty-state";
        empty.textContent = "No Hue items.";
        hueListEl.appendChild(empty);
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
    updateHueTypeButtons();
    await refreshAlerts();
    await refreshHueStatus();
    await refreshHue();
}

init();
setInterval(refreshAlerts, 4000);
setInterval(refreshHue, 6000);

// --- Care alerts (from mirror) ---
const careListEl = document.getElementById("careList");
const careErrEl = document.getElementById("careErr");

function setCareError(msg) {
    if (!careErrEl) return;
    if (!msg) {
        careErrEl.style.display = "none";
        careErrEl.textContent = "";
        return;
    }
    careErrEl.style.display = "block";
    careErrEl.textContent = msg;
}

function renderCareRow(item) {
    const row = document.createElement("div");
    row.className = "sr-row";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "sr-row-title";
    title.textContent = item.level ? `${item.level.toUpperCase()}: ${item.message}` : item.message;

    const meta = document.createElement("div");
    meta.className = "sr-row-meta";
    const ts = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";
    const careMetaParts = [ts];
    if (item.device) careMetaParts.push(item.device);
    if (item.acknowledgedAt) careMetaParts.push("ack");
    meta.textContent = careMetaParts.filter(Boolean).join(" | ");

    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "sr-row-actions";

    const ackBtn = document.createElement("button");
    ackBtn.className = "button is-small is-success is-light";
    ackBtn.textContent = item.acknowledgedAt ? "Acknowledged" : "Acknowledge";
    ackBtn.disabled = !!item.acknowledgedAt;
    ackBtn.onclick = async () => {
        await window.srFetch(`/api/care-alerts/ack/${encodeURIComponent(item.id)}`, { method: "POST" });
        await refreshCareAlerts();
    };

    const delBtn = document.createElement("button");
    delBtn.className = "button is-small is-danger is-light";
    delBtn.textContent = "Delete";
    delBtn.onclick = async () => {
        await window.srFetch(`/api/care-alerts/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        await refreshCareAlerts();
    };

    actions.appendChild(ackBtn);
    actions.appendChild(delBtn);

    row.appendChild(left);
    row.appendChild(actions);
    return row;
}

async function refreshCareAlerts() {
    if (!careListEl) return;
    try {
        setCareError(null);
        const res = await window.srFetch("/api/care-alerts", { method: "GET" });
        if (!res || !res.ok || !res.json) return;

        const items = Array.isArray(res.json.items) ? res.json.items : [];
        careListEl.innerHTML = "";
        if (!items.length) {
            const p = document.createElement("p");
            p.className = "sr-empty-state";
            p.textContent = "No care alerts.";
            careListEl.appendChild(p);
            return;
        }
        items.forEach((it) => careListEl.appendChild(renderCareRow(it)));
    } catch (e) {
        setCareError("Failed to load care alerts.");
    }
}

const careRefreshBtn = document.getElementById("careRefresh");
if (careRefreshBtn) careRefreshBtn.onclick = async () => refreshCareAlerts();

const careClearBtn = document.getElementById("careClear");
if (careClearBtn) careClearBtn.onclick = async () => {
    await window.srFetch("/api/care-alerts/clear", { method: "POST" });
    await refreshCareAlerts();
};

if (careListEl) {
    refreshCareAlerts();
    setInterval(refreshCareAlerts, 2500);
}

// --- Audio call (WebRTC) ---
const rtcStatusEl = document.getElementById("rtcStatus");
const rtcErrEl = document.getElementById("rtcErr");
const rtcListEl = document.getElementById("rtcList");
const rtcRemoteAudioEl = document.getElementById("rtcRemoteAudio");

const rtcState = {
    sessionId: null,
    pc: null,
    localStream: null,
    iceSince: 0,
    iceTimer: null,
    answerTimer: null,
    pendingLocalIce: []
};

function setRtcError(msg) {
    if (!rtcErrEl) return;
    if (!msg) {
        rtcErrEl.style.display = "none";
        rtcErrEl.textContent = "";
        return;
    }
    rtcErrEl.style.display = "block";
    rtcErrEl.textContent = msg;
}

function setRtcStatus(text, isActive) {
    if (!rtcStatusEl) return;
    rtcStatusEl.textContent = text || "Idle";
    rtcStatusEl.className = `tag ${isActive ? "is-success" : "is-light"}`;
}

function safePlayAudio(el) {
    if (!el) return;
    try { el.play().catch(() => {}); } catch (_) {}
}

function renderRtcSessionRow(item) {
    const row = document.createElement("div");
    row.className = "sr-row";

    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "sr-row-title";
    const who = item.caller === "mirror" ? "Mirror" : "Carer";
    t.textContent = `${who} call (${item.state || "ringing"})`;

    const meta = document.createElement("div");
    meta.className = "sr-row-meta";
    const rtcMetaParts = [item.createdAt ? new Date(item.createdAt).toLocaleString() : ""];
    if (item.device) rtcMetaParts.push(item.device);
    meta.textContent = rtcMetaParts.filter(Boolean).join(" | ");

    left.appendChild(t);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "sr-row-actions";

    if (item.caller === "mirror" && !item.hasAnswer && !item.endedAt && !item.declinedAt) {
        const ans = document.createElement("button");
        ans.className = "button is-small is-primary is-light";
        ans.textContent = "Answer";
        ans.onclick = async () => answerRtc(item.id);
        actions.appendChild(ans);
    }

    const hang = document.createElement("button");
    hang.className = "button is-small is-danger is-light";
    hang.textContent = "End";
    hang.onclick = async () => hangupRtc("end_clicked", item.id);
    actions.appendChild(hang);

    row.appendChild(left);
    row.appendChild(actions);
    return row;
}

async function refreshRtc() {
    if (!rtcListEl) return;
    try {
        setRtcError(null);
        const res = await window.srFetch("/api/rtc/sessions", { method: "GET" });
        if (!res || !res.ok || !res.json) return;

        const items = Array.isArray(res.json.items) ? res.json.items : [];
        const active = items.filter((x) => x && x.hasOffer && !x.endedAt && !x.declinedAt).slice(0, 10);

        rtcListEl.innerHTML = "";
        if (!active.length) {
            const empty = document.createElement("p");
            empty.className = "sr-empty-state";
            empty.textContent = "No active calls.";
            rtcListEl.appendChild(empty);
            if (!rtcState.sessionId) setRtcStatus("Idle", false);
            return;
        }

        active.forEach((it) => rtcListEl.appendChild(renderRtcSessionRow(it)));

        if (!rtcState.sessionId) setRtcStatus("Incoming / Active", false);
    } catch (e) {
        setRtcError("Failed to load calls.");
    }
}

async function createPeerConnectionCarer() {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

    pc.ontrack = (evt) => {
        if (!evt || !evt.streams || !evt.streams[0]) return;
        if (rtcRemoteAudioEl) rtcRemoteAudioEl.srcObject = evt.streams[0];
        safePlayAudio(rtcRemoteAudioEl);
    };

    pc.onicecandidate = async (evt) => {
        if (!evt || !evt.candidate) return;

        if (!rtcState.sessionId) {
            rtcState.pendingLocalIce.push(evt.candidate);
            while (rtcState.pendingLocalIce.length > 250) rtcState.pendingLocalIce.shift();
            return;
        }

        await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(rtcState.sessionId)}/ice`, {
            method: "POST",
            body: JSON.stringify({ candidate: evt.candidate })
        });
    };

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === "connected") setRtcStatus("In call", true);
        if (s === "failed" || s === "disconnected") setRtcStatus(`Connection ${s}`, false);
        if (s === "closed") setRtcStatus("Idle", false);
    };

    rtcState.pc = pc;
    return pc;
}

async function callMirrorRtc() {
    if (!rtcListEl) return;

    try {
        if (rtcState.sessionId) await hangupRtc("switch_session");

        rtcState.iceSince = 0;
        rtcState.pendingLocalIce = [];

        setRtcError(null);
        setRtcStatus("Calling...", false);
        const pc = await createPeerConnectionCarer();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            rtcState.localStream = stream;
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        } catch (e) {
            pc.addTransceiver("audio", { direction: "recvonly" });
            setRtcError("Microphone blocked - answering in listen-only mode.");
        }

        if (!rtcState.localStream) setRtcError("Microphone blocked - answering in listen-only mode.");

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const res = await window.srFetch("/api/rtc/call", {
            method: "POST",
            body: JSON.stringify({ mode: "audio", sdp: pc.localDescription })
        });

        if (!res || !res.ok || !res.json || !res.json.sessionId) {
            setRtcError("Failed to start call (server).");
            await hangupRtc("call_failed");
            return;
        }

        rtcState.sessionId = String(res.json.sessionId);

        const pendingCandidates = Array.isArray(rtcState.pendingLocalIce) ? rtcState.pendingLocalIce : [];
        rtcState.pendingLocalIce = [];
        for (const c of pendingCandidates) {
            await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(rtcState.sessionId)}/ice`, {
                method: "POST",
                body: JSON.stringify({ candidate: c })
            });
        }

        setRtcStatus("Ringing...", false);
        rtcState.answerTimer = setInterval(async () => pollAnswer(rtcState.sessionId), 900);
        rtcState.iceTimer = setInterval(async () => pollMirrorIce(rtcState.sessionId), 800);
        await refreshRtc();
    } catch (e) {
        setRtcError(`Call failed: ${e && e.message ? e.message : String(e)}`);
        await hangupRtc("call_exception");
    }
}

async function pollAnswer(sessionId) {
    if (!rtcState.sessionId || rtcState.sessionId !== sessionId) return;
    if (!rtcState.pc) return;

    const res = await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/answer`, { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    if (res.json.answer && rtcState.pc.signalingState !== "stable") {
        await rtcState.pc.setRemoteDescription(res.json.answer);
        setRtcStatus("In call", true);
    }
}

async function pollMirrorIce(sessionId) {
    if (!rtcState.sessionId || rtcState.sessionId !== sessionId) return;
    if (!rtcState.pc) return;

    const res = await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/ice?since=${rtcState.iceSince}&from=mirror`, { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    const items = Array.isArray(res.json.items) ? res.json.items : [];
    for (const it of items) {
        if (it && it.candidate) {
            try { await rtcState.pc.addIceCandidate(it.candidate); } catch (_) {}
        }
    }
    rtcState.iceSince = Number(res.json.next || rtcState.iceSince) || rtcState.iceSince;
}

async function answerRtc(sessionId) {
    try {
        if (rtcState.sessionId && rtcState.sessionId !== sessionId) await hangupRtc("switch_session");
        rtcState.sessionId = sessionId;
        rtcState.iceSince = 0;
        rtcState.pendingLocalIce = [];

        setRtcError(null);
        setRtcStatus("Answering...", false);
        const offerRes = await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/offer`, { method: "GET" });
        if (!offerRes || !offerRes.ok || !offerRes.json || !offerRes.json.offer) {
            setRtcError("No offer found.");
            return;
        }

        const pc = await createPeerConnectionCarer();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            rtcState.localStream = stream;
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        } catch (e) {
            pc.addTransceiver("audio", { direction: "recvonly" });
            setRtcError("Microphone blocked - listen-only.");
        }

        if (!rtcState.localStream) setRtcError("Microphone blocked - listen-only.");

        await pc.setRemoteDescription(offerRes.json.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const postRes = await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/answer`, {
            method: "POST",
            body: JSON.stringify({ sdp: pc.localDescription })
        });

        if (!postRes || !postRes.ok) {
            setRtcError("Failed to send answer.");
            await hangupRtc("answer_failed");
            return;
        }

        const pendingCandidates = Array.isArray(rtcState.pendingLocalIce) ? rtcState.pendingLocalIce : [];
        rtcState.pendingLocalIce = [];
        for (const c of pendingCandidates) {
            await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/ice`, {
                method: "POST",
                body: JSON.stringify({ candidate: c })
            });
        }

        setRtcStatus("In call", true);
        rtcState.iceTimer = setInterval(async () => pollMirrorIce(sessionId), 800);
        await refreshRtc();
    } catch (e) {
        setRtcError(`Answer failed: ${e && e.message ? e.message : String(e)}`);
        await hangupRtc("answer_exception");
    }
}

async function hangupRtc(reason, specificSessionId) {
    try {
        if (rtcState.answerTimer) clearInterval(rtcState.answerTimer);
        if (rtcState.iceTimer) clearInterval(rtcState.iceTimer);
        rtcState.answerTimer = null;
        rtcState.iceTimer = null;

        const sid = specificSessionId || rtcState.sessionId;
        if (sid) {
            await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sid)}/end`, {
                method: "POST",
                body: JSON.stringify({ reason: reason || "hangup" })
            });
        }

        if (rtcState.pc) {
            try { rtcState.pc.close(); } catch (_) {}
        }
        rtcState.pc = null;

        if (rtcState.localStream) {
            rtcState.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        }
        rtcState.localStream = null;
        rtcState.sessionId = null;
        rtcState.iceSince = 0;
        rtcState.pendingLocalIce = [];

        setRtcStatus("Idle", false);
        await refreshRtc();
    } catch (_) {
        setRtcStatus("Idle", false);
    }
}

const rtcCallBtn = document.getElementById("rtcCall");
if (rtcCallBtn) rtcCallBtn.onclick = async () => callMirrorRtc();

const rtcRefreshBtn = document.getElementById("rtcRefresh");
if (rtcRefreshBtn) rtcRefreshBtn.onclick = async () => refreshRtc();

const rtcHangupBtn = document.getElementById("rtcHangup");
if (rtcHangupBtn) rtcHangupBtn.onclick = async () => hangupRtc("carer_hangup");

if (rtcListEl) {
    refreshRtc();
    setInterval(refreshRtc, 2500);
}
