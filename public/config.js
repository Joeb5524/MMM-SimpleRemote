let picked = null;

let currentConfig = {};
let workingConfig = {};
let currentSchema = null;

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
        if (currentSchema) renderForm();
    } else {
        const details = (res && res.json) ? res.json : null;
        showBad("Save failed.", details);
    }
};

function setupTabs() {
    el("tabForm").onclick = () => setTab("form");
    el("tabJson").onclick = () => setTab("json");
}

function setTab(which) {
    const formBtn = el("tabForm");
    const jsonBtn = el("tabJson");

    const showForm = which === "form";
    formBtn.classList.toggle("sr-tab--active", showForm);
    jsonBtn.classList.toggle("sr-tab--active", !showForm);

    el("formPane").style.display = showForm ? "block" : "none";
    el("jsonPane").style.display = showForm ? "none" : "block";


    if (!showForm) syncJsonFromWorking();
}

function isJsonTabActive() {
    return el("tabJson").classList.contains("sr-tab--active");
}

async function init() {
    setupTabs();

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
            <div class="sr-mod__sub dimmed">${escapeHtml(m.header || "")}</div>
        `;

        div.onclick = async () => {
            picked = m;
            el("pickedTitle").textContent = `${m.module} (index ${m.index})`;
            el("load").disabled = false;
            el("save").disabled = false;
            el("tabs").style.display = "inline-flex";
            await loadPicked();
        };

        wrap.appendChild(div);
    });
}

async function loadPicked() {
    hideMsg();

    // load config
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


    currentSchema = await tryLoadSchema(picked.module);


    syncJsonFromWorking();
    updateSchemaHint();
    if (currentSchema) {
        renderForm();
        setTab("form");
    } else {
        // no schema  default to JSON editor
        el("formPane").style.display = "none";
        el("jsonPane").style.display = "block";
        el("tabForm").disabled = true;
        el("tabJson").disabled = false;
        el("tabForm").classList.remove("sr-tab--active");
        el("tabJson").classList.add("sr-tab--active");
    }
}

async function tryLoadSchema(moduleName) {
    el("tabForm").disabled = false;

    const res = await window.srFetch(`/api/config/schema?name=${encodeURIComponent(moduleName)}`, { method: "GET" });
    if (!res || !res.ok || !res.json || !res.json.ok) {
        el("tabForm").disabled = true;
        return null;
    }
    return res.json.schema || null;
}

function updateSchemaHint() {
    const hint = el("schemaHint");
    hint.style.display = "block";

    if (currentSchema) {
        hint.innerHTML = `Form editor is available (schema loaded). You can still use <strong>Advanced JSON</strong>.`;
    } else {
        hint.innerHTML = `No schema file found for this module, so only <strong>Advanced JSON</strong> is available.
            <span class="sr-muted">Add <code>schemas/${escapeHtml(picked.module)}.schema.json</code> to enable the form editor.</span>`;
    }
}

function renderForm() {
    const wrap = el("formWrap");
    wrap.innerHTML = "";

    el("tabForm").disabled = false;

    const schema = currentSchema;
    const root = schema && schema.type === "object" ? schema : { type: "object", properties: {} };


    const top = document.createElement("div");
    top.className = "sr-form__top";
    top.innerHTML = `
        <div class="sr-form__title">Edit config</div>
        <div class="sr-form__meta">
            <span class="sr-badge">schema-driven</span>
            <span class="sr-badge sr-badge--subtle">${escapeHtml(picked.module)}</span>
        </div>
    `;
    wrap.appendChild(top);

    const props = root.properties || {};
    const required = new Set(Array.isArray(root.required) ? root.required : []);

    Object.keys(props).sort().forEach((key) => {
        const fieldSchema = props[key] || {};
        const isReq = required.has(key);

        const row = renderFieldRow(key, fieldSchema, isReq);
        wrap.appendChild(row);
    });


    if (!Object.keys(props).length) {
        const empty = document.createElement("div");
        empty.className = "sr-form__empty";
        empty.textContent = "Schema has no editable properties. Use Advanced JSON.";
        wrap.appendChild(empty);
    }

    el("formPane").style.display = "block";
    el("jsonPane").style.display = "none";
}

function renderFieldRow(key, schema, isRequired) {
    const row = document.createElement("div");
    row.className = "sr-form__row";

    const label = document.createElement("div");
    label.className = "sr-form__label";
    label.innerHTML = `
        <div class="sr-form__labelTop">
            <span>${escapeHtml(key)}</span>
            ${isRequired ? `<span class="sr-pill">required</span>` : ``}
        </div>
        ${schema.description ? `<div class="sr-form__desc">${escapeHtml(schema.description)}</div>` : ``}
    `;

    const control = document.createElement("div");
    control.className = "sr-form__control";

    const value = workingConfig[key];

    const input = buildInputForSchema(schema, value, (nextVal) => {
        // Store
        if (nextVal === undefined) delete workingConfig[key];
        else workingConfig[key] = nextVal;

        syncJsonFromWorking();
    });

    control.appendChild(input);

    // reset
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
        renderForm();
        syncJsonFromWorking();
    };

    actions.appendChild(resetBtn);

    row.appendChild(label);
    row.appendChild(control);
    row.appendChild(actions);
    return row;
}

function buildInputForSchema(schema, value, onChange) {
    // enum => select
    if (Array.isArray(schema.enum)) {
        const sel = document.createElement("select");
        sel.className = "input";
        schema.enum.forEach(opt => {
            const o = document.createElement("option");
            o.value = String(opt);
            o.textContent = String(opt);
            sel.appendChild(o);
        });

        sel.value = value !== undefined ? String(value) : (schema.default !== undefined ? String(schema.default) : sel.value);
        sel.onchange = () => onChange(sel.value);
        return sel;
    }

    const t = schema.type;

    // bool
    if (t === "boolean") {
        const wrap = document.createElement("label");
        wrap.className = "sr-toggle";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = value !== undefined ? !!value : !!schema.default;
        cb.onchange = () => onChange(!!cb.checked);

        const text = document.createElement("span");
        text.className = "sr-toggle__text";
        text.textContent = cb.checked ? "On" : "Off";

        cb.addEventListener("change", () => {
            text.textContent = cb.checked ? "On" : "Off";
        });

        wrap.appendChild(cb);
        wrap.appendChild(text);
        return wrap;
    }

    // numbers
    if (t === "number" || t === "integer") {
        const input = document.createElement("input");
        input.className = "input";
        input.type = "number";
        if (Number.isFinite(schema.minimum)) input.min = String(schema.minimum);
        if (Number.isFinite(schema.maximum)) input.max = String(schema.maximum);
        if (Number.isFinite(schema.multipleOf)) input.step = String(schema.multipleOf);
        else input.step = t === "integer" ? "1" : "any";

        const start = value !== undefined ? value : schema.default;
        input.value = (start !== undefined && start !== null) ? String(start) : "";

        input.oninput = () => {
            const raw = input.value.trim();
            if (!raw) return onChange(undefined);
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            onChange(t === "integer" ? Math.trunc(n) : n);
        };

        return input;
    }

    // arrays
    if (t === "array") {
        const itemSchema = schema.items || {};
        const arr = Array.isArray(value) ? value : (Array.isArray(schema.default) ? schema.default : []);

        const box = document.createElement("div");
        box.className = "sr-array";

        const list = document.createElement("div");
        list.className = "sr-array__list";
        box.appendChild(list);

        function redraw() {
            list.innerHTML = "";

            const cur = Array.isArray(workingConfig[keyOfArrayHack]) ? workingConfig[keyOfArrayHack] : arr;
            const useArr = Array.isArray(cur) ? cur : [];

            useArr.forEach((v, idx) => {
                const row = document.createElement("div");
                row.className = "sr-array__row";

                const inp = buildInputForSchema(
                    normalizeSchemaForArrayItem(itemSchema),
                    v,
                    (nextVal) => {
                        const next = useArr.slice();
                        next[idx] = nextVal;
                        onChange(next);
                    }
                );

                const del = document.createElement("button");
                del.type = "button";
                del.className = "button is-small is-light";
                del.textContent = "Remove";
                del.onclick = () => {
                    const next = useArr.slice();
                    next.splice(idx, 1);
                    onChange(next.length ? next : []);
                    redraw();
                };

                row.appendChild(inp);
                row.appendChild(del);
                list.appendChild(row);
            });

            if (!useArr.length) {
                const empty = document.createElement("div");
                empty.className = "sr-array__empty";
                empty.textContent = "No items";
                list.appendChild(empty);
            }
        }

        const add = document.createElement("button");
        add.type = "button";
        add.className = "button is-small is-link is-light";
        add.textContent = "Add item";
        add.onclick = () => {
            const base = Array.isArray(value) ? value : [];
            const next = base.slice();
            next.push(defaultForSchema(itemSchema));
            onChange(next);
            redraw();
        };


        const keyOfArrayHack = "__sr_key__" + Math.random().toString(36).slice(2);

        Object.defineProperty(workingConfig, keyOfArrayHack, { value: arr, writable: true });


        const originalOnChange = onChange;
        onChange = (next) => {
            workingConfig[keyOfArrayHack] = next;
            originalOnChange(next);
        };

        box.appendChild(add);
        redraw();
        return box;
    }

    // objects => JSON mini-editor
    if (t === "object") {
        const ta = document.createElement("textarea");
        ta.className = "textarea";
        ta.rows = 4;
        ta.placeholder = "Enter JSON object…";

        const start = value !== undefined ? value : schema.default;
        ta.value = JSON.stringify(start || {}, null, 2);

        const note = document.createElement("div");
        note.className = "sr-inlinehelp";
        note.textContent = "Object editing uses JSON here (schema rendering for nested objects can be added later).";

        const wrap = document.createElement("div");
        wrap.appendChild(ta);
        wrap.appendChild(note);

        let lastGood = start || {};
        ta.oninput = () => {
            try {
                const parsed = JSON.parse(ta.value);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    lastGood = parsed;
                    ta.classList.remove("sr-bad");
                    onChange(parsed);
                } else {
                    ta.classList.add("sr-bad");
                }
            } catch (_) {
                ta.classList.add("sr-bad");
            }
        };

        return wrap;
    }

    // string (default)
    const input = document.createElement("input");
    input.className = "input";
    input.type = "text";
    input.placeholder = schema.default !== undefined ? String(schema.default) : "";

    const start = value !== undefined ? value : schema.default;
    input.value = (start !== undefined && start !== null) ? String(start) : "";

    input.oninput = () => {
        const s = input.value;
        if (s.trim() === "" && schema.default === undefined) onChange(undefined);
        else onChange(s);
    };

    return input;
}

function normalizeSchemaForArrayItem(itemSchema) {
    // default to string
    if (!itemSchema || typeof itemSchema !== "object") return { type: "string" };
    if (!itemSchema.type && !itemSchema.enum) return { ...itemSchema, type: "string" };
    return itemSchema;
}

function defaultForSchema(schema) {
    if (!schema || typeof schema !== "object") return "";
    if (schema.default !== undefined) return deepClone(schema.default);
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    switch (schema.type) {
        case "boolean": return false;
        case "number":
        case "integer": return 0;
        case "array": return [];
        case "object": return {};
        default: return "";
    }
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