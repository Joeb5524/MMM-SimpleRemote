const btn = document.getElementById("btn");
const err = document.getElementById("err");

btn.onclick = async () => {
    err.style.display = "none";

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    const res = await window.srFetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
    });

    if (res && res.ok && res.json && res.json.ok) {
        window.location.href = `${window.SR_BASE}/dashboard`;
    } else {
        err.style.display = "block";
    }
};