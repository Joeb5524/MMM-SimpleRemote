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
    await refreshCareAlerts();
    } else {
        sendErr.style.display = "block";
    }
};

document.getElementById("clear").onclick = async () => {
    await window.srFetch("/api/alerts/clear", { method: "POST" });
    await refreshAlerts();
    await refreshCareAlerts();
};

const careCount = document.getElementById("careCount");

document.getElementById("careRefresh").onclick = async () => {
    await refreshCareAlerts();
};

document.getElementById("careClear").onclick = async () => {
    await window.srFetch("/api/care-alerts/clear", { method: "POST" });
    await refreshCareAlerts();
};

async function refreshCareAlerts() {
    const res = await window.srFetch("/api/care-alerts", { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    const q = document.getElementById("careQueue");
    q.innerHTML = "";

    const items = res.json.items || [];
    careCount.textContent = String(items.filter(i => i && !i.acknowledgedAt).length);

    items
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .forEach(item => q.appendChild(renderCareAlertRow(item)));
}

function renderCareAlertRow(item) {
    const row = document.createElement("div");
    row.className = "sr-row";

    const left = document.createElement("div");

    const t = document.createElement("div");
    t.className = "sr-row-title";
    t.textContent = item.title || "Mirror alert";

    const m = document.createElement("div");
    m.className = "sr-row-msg";
    m.textContent = item.message || "";

    const meta = document.createElement("div");
    meta.className = "sr-chip";
    meta.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";

    left.appendChild(t);
    left.appendChild(m);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.className = "buttons";

    const ack = document.createElement("button");
    ack.className = "button is-small " + (item.acknowledgedAt ? "is-success is-light" : "is-success");
    ack.textContent = item.acknowledgedAt ? "Acknowledged" : "Acknowledge";
    ack.disabled = !!item.acknowledgedAt;

    ack.onclick = async () => {
        if (!item.id) return;
        await window.srFetch(`/api/care-alerts/ack/${encodeURIComponent(item.id)}`, { method: "POST" });
        await refreshCareAlerts();
    };

    const del = document.createElement("button");
    del.className = "button is-small is-light";
    del.textContent = "Delete";
    del.onclick = async () => {
        if (!item.id) return;
        await window.srFetch(`/api/care-alerts/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        await refreshCareAlerts();
    };

    right.appendChild(ack);
    right.appendChild(del);

    row.appendChild(left);
    row.appendChild(right);

    return row;
}

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
    await refreshCareAlerts();
    };

    row.appendChild(left);
    row.appendChild(del);
    return row;
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

document.getElementById("rtcCall").onclick = async () => {
    await callMirrorRtc();
};

document.getElementById("rtcRefresh").onclick = async () => {
    await refreshRtc();
};

document.getElementById("rtcHangup").onclick = async () => {
    await hangupRtc("carer_hangup");
};

function setRtcError(msg) {
    if (!msg) {
        rtcErrEl.style.display = "none";
        rtcErrEl.textContent = "";
        return;
    }
    rtcErrEl.style.display = "block";
    rtcErrEl.textContent = msg;
}

function setRtcStatus(text, isActive) {
    rtcStatusEl.textContent = text || "Idle";
    rtcStatusEl.className = `tag level-item ${isActive ? "is-success" : "is-light"}`;
}

function renderRtcSessionRow(item) {
    const row = document.createElement("div");
    row.className = "sr-row";

    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "sr-row-title";
    t.textContent = `Session ${item.id}`;

    const meta = document.createElement("div");
    meta.className = "sr-chip";
    const ageSec = Math.floor((item.ageMs || 0) / 1000);
    const who = item.caller === "carer" ? "Outgoing" : "Incoming";
    meta.textContent = item.endedAt ? `Ended (${ageSec}s)` : item.hasAnswer ? `In call (${ageSec}s)` : `${who} (${ageSec}s)`;

    left.appendChild(t);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.className = "buttons";

    if (!item.endedAt && item.hasOffer && !item.hasAnswer && (item.caller || "mirror") === "mirror") {
        const ans = document.createElement("button");
        ans.className = "button is-small is-primary";
        ans.textContent = "Answer";
        ans.onclick = async () => {
            await answerRtc(item.id);
        };
        right.appendChild(ans);
    }

    if (!item.endedAt) {
        const end = document.createElement("button");
        end.className = "button is-small is-danger";
        end.textContent = "End";
        end.onclick = async () => {
            await endRtcSession(item.id, "ended_from_dashboard");
            await refreshRtc();
        };
        right.appendChild(end);
    }

    row.appendChild(left);
    row.appendChild(right);
    return row;
}

async function refreshRtc() {
    try {
        setRtcError(null);
        const res = await window.srFetch("/api/rtc/sessions", { method: "GET" });
        if (!res || !res.ok || !res.json) return;

        const items = (res.json.items || []).filter((x) => x && x.hasOffer && !x.endedAt);
        rtcListEl.innerHTML = "";
        if (!items.length) {
            const empty = document.createElement("p");
            empty.className = "help";
            empty.textContent = "No active calls.";
            rtcListEl.appendChild(empty);
            if (!rtcState.sessionId) setRtcStatus("Idle", false);
            return;
        }

        items.forEach((it) => rtcListEl.appendChild(renderRtcSessionRow(it)));
        if (!rtcState.sessionId) setRtcStatus("Incoming", false);
    } catch (e) {
        setRtcError("Failed to load RTC sessions.");
    }
}

async function answerRtc(sessionId) {
    if (rtcState.sessionId && rtcState.sessionId !== sessionId) {
        await hangupRtc("switch_session");
    }

    rtcState.sessionId = sessionId;
    rtcState.iceSince = 0;
    rtcState.pendingLocalIce = [];

    setRtcError(null);
    setRtcStatus("Answering…", false);

    const offerRes = await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/offer`, { method: "GET" });
    if (!offerRes || !offerRes.ok || !offerRes.json || !offerRes.json.sdp) {
        setRtcError("Offer missing / expired.");
        rtcState.sessionId = null;
        return;
    }

    const offer = offerRes.json.sdp;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    rtcState.pc = pc;

    let stream = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        rtcState.localStream = stream;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        pc.addTransceiver("audio", { direction: "sendrecv" });
    } catch (e) {
        // Listen-only fallback (common if not HTTPS).
        pc.addTransceiver("audio", { direction: "recvonly" });
    }

    pc.ontrack = (evt) => {
        if (!evt || !evt.streams || !evt.streams[0]) return;
        rtcRemoteAudioEl.srcObject = evt.streams[0];
    };

    pc.onicecandidate = async (evt) => {
        if (!evt || !evt.candidate) return;
        await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/ice`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ candidate: evt.candidate })
        });
    };

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === "connected") setRtcStatus("In call", true);
        if (s === "failed" || s === "disconnected") setRtcStatus(`Connection ${s}`, false);
        if (s === "closed") setRtcStatus("Idle", false);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription })
    });

    setRtcStatus("Connecting…", false);

    rtcState.iceTimer = setInterval(async () => {
        await pollMirrorIce(sessionId);
    }, 800);
}

async function pollMirrorIce(sessionId) {
    if (!rtcState.sessionId || rtcState.sessionId !== sessionId) return;
    if (!rtcState.pc) return;

    const res = await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/ice?since=${rtcState.iceSince}`, { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    const items = res.json.items || [];
    for (const it of items) {
        if (!it || !it.candidate) continue;
        try {
            await rtcState.pc.addIceCandidate(new RTCIceCandidate(it.candidate));
        } catch (e) {}
    }

    rtcState.iceSince = Number(res.json.nextSince || (rtcState.iceSince + items.length)) || rtcState.iceSince;
}


async function callMirrorRtc() {
    if (rtcState.sessionId) {
        await hangupRtc("switch_session");
    }

    rtcState.iceSince = 0;
    rtcState.pendingLocalIce = [];
    rtcState.pendingLocalIce = [];

    setRtcError(null);
    setRtcStatus("Calling…", false);

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    rtcState.pc = pc;

    let stream = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        rtcState.localStream = stream;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        pc.addTransceiver("audio", { direction: "sendrecv" });
    } catch (e) {
        // Listen-only fallback.
        pc.addTransceiver("audio", { direction: "recvonly" });
    }

    pc.ontrack = (evt) => {
        if (!evt || !evt.streams || !evt.streams[0]) return;
        rtcRemoteAudioEl.srcObject = evt.streams[0];
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
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ candidate: evt.candidate })
        });
    };

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === "connected") setRtcStatus("In call", true);
        if (s === "failed" || s === "disconnected") setRtcStatus(`Connection ${s}`, false);
        if (s === "closed") setRtcStatus("Idle", false);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await window.srFetch("/api/rtc/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "audio", sdp: pc.localDescription })
    });

    if (!res || !res.ok || !res.json || !res.json.sessionId) {
        setRtcError("Failed to start call.");
        await hangupRtc("call_failed");
        return;
    }

    rtcState.sessionId = String(res.json.sessionId);

    const pending = Array.isArray(rtcState.pendingLocalIce) ? rtcState.pendingLocalIce : [];
    rtcState.pendingLocalIce = [];
    for (const c of pending) {
        await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(rtcState.sessionId)}/ice`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ candidate: c })
        });
    }

    setRtcStatus("Ringing…", false);

    rtcState.answerTimer = setInterval(async () => {
        await pollAnswer(rtcState.sessionId);
    }, 900);

    rtcState.iceTimer = setInterval(async () => {
        await pollMirrorIce(rtcState.sessionId);
    }, 800);
}

async function pollAnswer(sessionId) {
    if (!rtcState.sessionId || rtcState.sessionId !== sessionId) return;
    if (!rtcState.pc) return;

    const res = await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/answer`, { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    if (res.json.declinedAt || res.json.endedAt) {
        setRtcError("Call declined / ended.");
        await hangupRtc("declined");
        return;
    }

    if (!res.json.sdp) return;

    if (rtcState.answerTimer) clearInterval(rtcState.answerTimer);
    rtcState.answerTimer = null;

    try {
        await rtcState.pc.setRemoteDescription(new RTCSessionDescription(res.json.sdp));
        setRtcStatus("Connecting…", false);
    } catch (e) {
        setRtcError("Failed to apply answer.");
        await hangupRtc("bad_answer");
    }
}

async function endRtcSession(sessionId, reason) {
    await window.srFetch(`/api/rtc/sessions/${encodeURIComponent(sessionId)}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason || "ended" })
    });
}

async function hangupRtc(reason) {
    try {
        if (rtcState.iceTimer) clearInterval(rtcState.iceTimer);
        rtcState.iceTimer = null;

        if (rtcState.answerTimer) clearInterval(rtcState.answerTimer);
        rtcState.answerTimer = null;

        if (rtcState.localStream) {
            rtcState.localStream.getTracks().forEach((t) => {
                try { t.stop(); } catch (e) {}
            });
        }

        if (rtcState.pc) rtcState.pc.close();
    } catch (e) {}

    if (rtcState.sessionId) await endRtcSession(rtcState.sessionId, reason || "hangup");

    rtcState.sessionId = null;
    rtcState.pc = null;
    rtcState.localStream = null;
    rtcState.iceSince = 0;
    rtcState.pendingLocalIce = [];
    rtcRemoteAudioEl.srcObject = null;

    setRtcStatus("Idle", false);
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
    await refreshCareAlerts();
    await refreshHueStatus();
    await refreshHue();
    await refreshRtc();
}

init();
setInterval(refreshAlerts, 4000);
setInterval(refreshCareAlerts, 5000);
setInterval(refreshHue, 6000);
setInterval(refreshRtc, 2000);