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
        await refresh();
    } else {
        sendErr.style.display = "block";
    }
};

document.getElementById("clear").onclick = async () => {
    await window.srFetch("/api/alerts/clear", { method: "POST" });
    await refresh();
};

async function refresh() {
    const res = await window.srFetch("/api/alerts", { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    const q = document.getElementById("queue");
    q.innerHTML = "";

    const active = res.json.active;
    const queue = res.json.queue || [];

    if (active) {
        q.appendChild(renderRow(active, true));
    }

    queue.forEach(item => q.appendChild(renderRow(item, false)));
}

function renderRow(item, isActive) {
    const row = document.createElement("div");
    row.className = "sr-row";

    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "sr-row-title";
    t.textContent = `${isActive ? "LIVE: " : ""}${item.title || "Alert"}`;

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
        await refresh();
    };

    row.appendChild(left);
    row.appendChild(del);
    return row;
}

refresh();
setInterval(refresh, 4000);