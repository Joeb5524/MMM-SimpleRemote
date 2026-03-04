let picked = null;

let pickedSchema = null;

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

    pickedSchema = await loadSchemaForPicked();

    syncJsonFromWorking();
    renderForm();
    setTab("form");
}

function renderForm() {
    // module-specific friendly editors
    if (renderSimpleEditorIfAvailable()) return;

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

async function loadSchemaForPicked() {
    if (!picked || !picked.module) return null;
    const res = await window.srFetch(`/api/config/schema?name=${encodeURIComponent(picked.module)}`, { method: "GET" });
    if (!res || !res.ok || !res.json || !res.json.ok) return null;
    return res.json.schema || null;
}

function renderSimpleEditorIfAvailable() {
    const simple = el("simplePane");
    const wrap = el("formWrap");

    simple.innerHTML = "";
    simple.style.display = "none";
    wrap.style.display = "block";


    el("addField").style.display = "inline-flex";

    // user friendly editor
    if (picked && picked.module === "MMM-MedicationReminder") {
        el("addField").style.display = "none";
        wrap.style.display = "none";
        simple.style.display = "block";
        renderMedicationReminderEditor(simple);
        return true;
    }

    return false;
}

function renderMedicationReminderEditor(host) {
    const cfg = workingConfig || {};
    if (!Array.isArray(cfg.medications)) cfg.medications = [];

    const title = document.createElement("div");
    title.className = "mb-3";
    title.innerHTML = `
        <h3 class="title is-6">Medication schedule</h3>
        <div class="sr-subhelp">Add medications below.</div>
    `;
    host.appendChild(title);

    const tableWrap = document.createElement("div");
    tableWrap.className = "table-container";

    const table = document.createElement("table");
    table.className = "table is-fullwidth is-striped";
    table.innerHTML = `
        <thead>
            <tr>
                <th>Medication</th>
                <th>Dose</th>
                <th style="width:140px;">Time</th>
                <th style="width:110px;"></th>
            </tr>
        </thead>
        <tbody></tbody>
    `;

    const tbody = table.querySelector("tbody");

    const ensureRowShape = (m) => ({
        name: (m && typeof m.name === "string") ? m.name : "",
        dosage: (m && typeof m.dosage === "string") ? m.dosage : "",
        time: (m && typeof m.time === "string") ? m.time : "08:00"
    });

    const timeOk = (s) => /^[0-2][0-9]:[0-5][0-9]$/.test(String(s || ""));

    function renderRows() {
        tbody.innerHTML = "";

        cfg.medications = cfg.medications.map(ensureRowShape);

        if (!cfg.medications.length) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 4;
            td.className = "has-text-grey";
            td.textContent = "No medications added yet.";
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }

        cfg.medications.forEach((m, idx) => {
            const tr = document.createElement("tr");

            // name
            const tdName = document.createElement("td");
            const nameInput = document.createElement("input");
            nameInput.className = "input";
            nameInput.type = "text";
            nameInput.placeholder = "e.g. Fluoxetine";
            nameInput.value = m.name;
            nameInput.oninput = () => {
                cfg.medications[idx].name = nameInput.value;
                workingConfig = cfg;
                syncJsonFromWorking();
            };
            tdName.appendChild(nameInput);
            tr.appendChild(tdName);

            // dosage
            const tdDose = document.createElement("td");
            const doseInput = document.createElement("input");
            doseInput.className = "input";
            doseInput.type = "text";
            doseInput.placeholder = "e.g. 50mg";
            doseInput.value = m.dosage;
            doseInput.oninput = () => {
                cfg.medications[idx].dosage = doseInput.value;
                workingConfig = cfg;
                syncJsonFromWorking();
            };
            tdDose.appendChild(doseInput);
            tr.appendChild(tdDose);

            // time
            const tdTime = document.createElement("td");
            const timeInput = document.createElement("input");
            timeInput.className = "input";
            timeInput.type = "time";
            timeInput.step = "60";
            timeInput.value = timeOk(m.time) ? m.time : "08:00";
            timeInput.oninput = () => {
                const v = String(timeInput.value || "");
                cfg.medications[idx].time = v;
                workingConfig = cfg;
                syncJsonFromWorking();
            };
            tdTime.appendChild(timeInput);
            tr.appendChild(tdTime);

            // actions
            const tdAct = document.createElement("td");
            const del = document.createElement("button");
            del.type = "button";
            del.className = "button is-small is-light";
            del.textContent = "Remove";
            del.onclick = () => {
                cfg.medications.splice(idx, 1);
                workingConfig = cfg;
                syncJsonFromWorking();
                renderRows();
            };
            tdAct.appendChild(del);
            tr.appendChild(tdAct);

            tbody.appendChild(tr);
        });
    }

    tableWrap.appendChild(table);
    host.appendChild(tableWrap);

    const controls = document.createElement("div");
    controls.className = "buttons mt-3";

    const add = document.createElement("button");
    add.type = "button";
    add.className = "button is-link";
    add.textContent = "Add medication";
    add.onclick = () => {
        cfg.medications.push({ name: "", dosage: "", time: "08:00" });
        workingConfig = cfg;
        syncJsonFromWorking();
        renderRows();
    };

    const quick = document.createElement("button");
    quick.type = "button";
    quick.className = "button is-light";
    quick.textContent = "Add example";
    quick.onclick = () => {
        cfg.medications.push({ name: "Paracetamol", dosage: "500mg", time: "08:00" });
        workingConfig = cfg;
        syncJsonFromWorking();
        renderRows();
    };

    controls.appendChild(add);
    controls.appendChild(quick);
    host.appendChild(controls);

    // Other settings (simple)
    const settings = document.createElement("div");
    settings.className = "mt-4";
    settings.innerHTML = `
        <h3 class="title is-6">Reminder settings</h3>
        <div class="sr-subhelp">Optional behaviour tweaks.</div>
    `;
    host.appendChild(settings);

    const friendly = [
        { key: "alertWindowMinutes", label: "Alert window (minutes)", help: "How early/late around the time it still counts as due." },
        { key: "missedGraceMinutes", label: "Missed grace (minutes)", help: "How long before a due dose becomes ‘missed’." },
        { key: "showRelative", label: "Show relative times", help: "Show ‘in 10 minutes’ style text if supported." },
        { key: "maxItems", label: "Max items on screen", help: "Limit how many reminders to render at once." }
    ];

    friendly.forEach(({ key, label, help }) => {
        if (!(key in cfg)) return;

        const field = document.createElement("div");
        field.className = "field";

        const lab = document.createElement("label");
        lab.className = "label";
        lab.textContent = label;

        const ctrl = document.createElement("div");
        ctrl.className = "control";

        const input = buildInputForValue(key, cfg[key]);
        ctrl.appendChild(input);

        const p = document.createElement("p");
        p.className = "help";
        p.textContent = help;

        field.appendChild(lab);
        field.appendChild(ctrl);
        field.appendChild(p);
        host.appendChild(field);
    });

    renderRows();
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