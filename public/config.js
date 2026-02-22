let picked = null;

document.getElementById("logout").onclick = async () => {
    await window.srFetch("/api/logout", { method: "POST" });
    window.location.href = `${window.SR_BASE}/login`;
};

document.getElementById("load").onclick = async () => {
    if (!picked) return;
    await loadPicked();
};

document.getElementById("save").onclick = async () => {
    hideMsg();

    if (!picked) return;

    let nextConfig;
    try {
        nextConfig = JSON.parse(document.getElementById("json").value);
    } catch (e) {
        showBad("Config JSON is not valid.");
        return;
    }

    const patch = diffToReplacePatch(nextConfig);
    const res = await window.srFetch("/api/config/module", {
        method: "PATCH",
        body: JSON.stringify({
            name: picked.module,
            index: picked.index,
            patch
        })
    });

    if (res && res.ok && res.json && res.json.ok) {
        showOk("Saved. Mirror will refresh.");
    } else {
        const details = (res && res.json) ? res.json : null;
        showBad("Save failed.", details);
    }
};

async function init() {
    const res = await window.srFetch("/api/config/modules", { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    const list = res.json.modules || [];
    const wrap = document.getElementById("modules");
    wrap.innerHTML = "";

    list.forEach(m => {
        const div = document.createElement("div");
        div.className = "sr-mod";
        div.innerHTML = `<div><strong>${escapeHtml(m.module)}</strong></div>
      <div class="sr-chip">${escapeHtml(m.position || "")} #${m.index}</div>`;
        div.onclick = async () => {
            picked = m;
            document.getElementById("pickedTitle").textContent = `${m.module} (index ${m.index})`;
            document.getElementById("load").disabled = false;
            document.getElementById("save").disabled = false;
            await loadPicked();
        };
        wrap.appendChild(div);
    });
}

async function loadPicked() {
    hideMsg();
    const res = await window.srFetch(`/api/config/module?name=${encodeURIComponent(picked.module)}&index=${picked.index}`, { method: "GET" });
    if (!res || !res.ok || !res.json || !res.json.ok) {
        showBad("Failed to load module config.");
        return;
    }
    document.getElementById("json").value = JSON.stringify(res.json.config || {}, null, 2);
}

function diffToReplacePatch(nextConfig) {

    return [{ op: "replace", path: "", value: nextConfig }];
}

function hideMsg() {
    document.getElementById("ok").style.display = "none";
    document.getElementById("bad").style.display = "none";
    document.getElementById("details").style.display = "none";
    document.getElementById("details").textContent = "";
}

function showOk(msg) {
    const el = document.getElementById("ok");
    el.textContent = msg;
    el.style.display = "block";
}

function showBad(msg, details) {
    const el = document.getElementById("bad");
    el.textContent = msg;
    el.style.display = "block";

    if (details) {
        const d = document.getElementById("details");
        d.textContent = JSON.stringify(details, null, 2);
        d.style.display = "block";
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
}

init();