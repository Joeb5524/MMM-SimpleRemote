let picked = null;

let currentConfig = {};
let workingConfig = {};

const el = (id) => document.getElementById(id);

el("logout").onclick = async () => {
    await window.srFetch("/api/logout", { method: "POST" });
    window.location.href = `${window.SR_BASE}/login`;
};

el("load").onclick = async () => {
    if (!picked) return;
    await loadPicked();
};

el("save").onclick = async () => {
    hideMsg();
    if (!picked) return;

    const activeJson = isJsonTabActive();
    let nextConfig = null;

    if (activeJson) {
        try {
            nextConfig = JSON.parse(el("json").value);
        } catch (e) {
            showBad("Config JSON is not valid.");
            return;
        }
    } else {
        nextConfig = deepClone(workingConfig || {});
    }

    const res = await window.srFetch("/api/config/module", {
        method: "PATCH",
        body: JSON.stringify({
            name: picked.module,
            index: picked.index,
            config: nextConfig
        })
    });

    if (res && res.ok && res.json && res.json.ok) {
        showOk("Saved. Mirror will refresh.");
        currentConfig = deepClone(nextConfig);
        workingConfig = deepClone(nextConfig);
        syncJsonFromWorking();
        renderForm();
    } else {
        const details = (res && res.json) ? res.json : null;
        showBad("Save failed.", details);
    }
};

el("tabForm").onclick = () => setTab("form");
el("tabJson").onclick = () => setTab("json");

el("addField").onclick = () => {
    if (!picked) return;

    const key = prompt("New config key (e.g. 'use24Hour'):");
    if (!key) return;

    const clean = String(key).trim();
    if (!clean) return;

    if (Object.prototype.hasOwnProperty.call(workingConfig, clean)) {
        alert("That key already exists.");
        return;
    }


    workingConfig[clean] = "";
    syncJsonFromWorking();
    renderForm();
};

function setupEditorVisible() {
    el("tabs").style.display = "inline-flex";
    el("hint").style.display = "block";
    el("load").disabled = false;
    el("save").disabled = false;
}

function setTab(which) {
    const showForm = which === "form";
    el("tabForm").classList.toggle("sr-tab--active", showForm);
    el("tabJson").classList.toggle("sr-tab--active", !showForm);

    el("formPane").style.display = showForm ? "block" : "none";
    el("jsonPane").style.display = showForm ? "none" : "block";

    if (!showForm) syncJsonFromWorking();
}

function isJsonTabActive() {
    return el("tabJson").classList.contains("sr-tab--active");
}

async function init() {
    const res = await window.srFetch("/api/config/modules", { method: "GET" });
    if (!res || !res.ok || !res.json) return;

    const list = res.json.modules || [];
    const wrap = el("modules");
    wrap.innerHTML = "";

    list.forEach(m => {
        const div = document.createElement("div");
        div.className = "sr-mod";
        div.innerHTML = `
            <div class="sr-mod__top">
                <div><strong>${escapeHtml(m.module)}</strong></div>
                <div class="sr-chip">${escapeHtml(m.position || "")} #${m.index}</div>
            </div>
            ${m.header ? `<div class="sr-mod__sub dimmed">${escapeHtml(m.header)}</div>` : ``}
        `;

        div.onclick = async () => {
            picked = m;
            el("pickedTitle").textContent = `${m.module} (index ${m.index})`;
            setupEditorVisible();
            await loadPicked();
        };

        wrap.appendChild(div);
    });
}

async function loadPicked() {
    hideMsg();

    const res = await window.srFetch(
        `/api/config/module?name=${encodeURIComponent(picked.module)}&index=${picked.index}`,
        { method: "GET" }
    );

    if (!res || !res.ok || !res.json || !res.json.ok) {
        showBad("Failed to load module config.");
        return;
    }

    currentConfig = deepClone(res.json.config || {});
    workingConfig = deepClone(currentConfig);

    syncJsonFromWorking();
    renderForm();
    setTab("form");
}

function renderForm() {
    const wrap = el("formWrap");
    wrap.innerHTML = "";

    const keys = Object.keys(workingConfig || {}).sort((a, b) => a.localeCompare(b));

    if (!keys.length) {
        const empty = document.createElement("div");
        empty.className = "sr-form__empty";
        empty.textContent = "No config keys found for this module. Use “Add field” or Advanced JSON.";
        wrap.appendChild(empty);
        return;
    }

    keys.forEach((key) => {
        const val = workingConfig[key];

        const row = document.createElement("div");
        row.className = "sr-form__row";

        const label = document.createElement("div");
        label.className = "sr-form__label";
        label.innerHTML = `
            <div class="sr-form__labelTop">
                <span>${escapeHtml(key)}</span>
                <span class="sr-pill">${escapeHtml(inferTypeLabel(val))}</span>
            </div>
        `;

        const control = document.createElement("div");
        control.className = "sr-form__control";
        control.appendChild(buildInputForValue(key, val));

        const actions = document.createElement("div");
        actions.className = "sr-form__actions";

        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "button is-small is-light";
        resetBtn.textContent = "Reset";
        resetBtn.onclick = () => {
            const orig = currentConfig[key];
            if (orig === undefined) delete workingConfig[key];
            else workingConfig[key] = deepClone(orig);
            syncJsonFromWorking();
            renderForm();
        };

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "button is-small is-light";
        delBtn.textContent = "Remove";
        delBtn.onclick = () => {
            const ok = confirm(`Remove '${key}' from config?`);
            if (!ok) return;
            delete workingConfig[key];
            syncJsonFromWorking();
            renderForm();
        };

        actions.appendChild(resetBtn);
        actions.appendChild(delBtn);

        row.appendChild(label);
        row.appendChild(control);
        row.appendChild(actions);

        wrap.appendChild(row);
    });
}

function buildInputForValue(key, val) {
    // boolean => toggle
    if (typeof val === "boolean") {
        const wrap = document.createElement("label");
        wrap.className = "sr-toggle";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!val;

        const text = document.createElement("span");
        text.className = "sr-toggle__text";
        text.textContent = cb.checked ? "On" : "Off";

        cb.onchange = () => {
            workingConfig[key] = !!cb.checked;
            text.textContent = cb.checked ? "On" : "Off";
            syncJsonFromWorking();
        };

        wrap.appendChild(cb);
        wrap.appendChild(text);
        return wrap;
    }

    // number
    if (typeof val === "number") {
        const input = document.createElement("input");
        input.className = "input";
        input.type = "number";
        input.step = Number.isInteger(val) ? "1" : "any";
        input.value = String(val);

        input.oninput = () => {
            const raw = input.value.trim();
            if (!raw) return;
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            workingConfig[key] = Number.isInteger(val) ? Math.trunc(n) : n;
            syncJsonFromWorking();
        };

        return input;
    }

    // arrays/objects
    if (val && typeof val === "object") {
        const ta = document.createElement("textarea");
        ta.className = "textarea";
        ta.rows = 4;
        ta.value = JSON.stringify(val, null, 2);

        const note = document.createElement("div");
        note.className = "sr-inlinehelp";
        note.textContent = "Editing as JSON (arrays/objects).";

        const wrap = document.createElement("div");
        wrap.appendChild(ta);
        wrap.appendChild(note);

        ta.oninput = () => {
            try {
                const parsed = JSON.parse(ta.value);
                // allow arrays or objects only here
                if (parsed && typeof parsed === "object") {
                    ta.classList.remove("sr-bad");
                    workingConfig[key] = parsed;
                    syncJsonFromWorking();
                } else {
                    ta.classList.add("sr-bad");
                }
            } catch (_) {
                ta.classList.add("sr-bad");
            }
        };

        return wrap;
    }

    // string
    const input = document.createElement("input");
    input.className = "input";
    input.type = "text";
    input.value = (val === null || val === undefined) ? "" : String(val);

    input.oninput = () => {
        // Keep as string (inference-only approach; user can convert via JSON tab if needed)
        workingConfig[key] = input.value;
        syncJsonFromWorking();
    };

    return input;
}

function inferTypeLabel(val) {
    if (Array.isArray(val)) return "array";
    if (val === null) return "null";
    const t = typeof val;
    if (t === "object") return "object";
    return t;
}

function syncJsonFromWorking() {
    el("json").value = JSON.stringify(workingConfig || {}, null, 2);
}

function hideMsg() {
    el("ok").style.display = "none";
    el("bad").style.display = "none";
    el("details").style.display = "none";
    el("details").textContent = "";
}

function showOk(msg) {
    const e = el("ok");
    e.textContent = msg;
    e.style.display = "block";
}

function showBad(msg, details) {
    const e = el("bad");
    e.textContent = msg;
    e.style.display = "block";

    if (details) {
        const d = el("details");
        d.textContent = JSON.stringify(details, null, 2);
        d.style.display = "block";
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
}

function deepClone(x) {
    return JSON.parse(JSON.stringify(x));
}

init();