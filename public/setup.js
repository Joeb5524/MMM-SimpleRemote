const btn = document.getElementById("btn");
const err = document.getElementById("err");

btn.onclick = async () => {
    err.style.display = "none";
    err.textContent = "";

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const confirmPassword = document.getElementById("confirmPassword").value;

    const res = await window.srFetch("/api/bootstrap/setup", {
        method: "POST",
        body: JSON.stringify({ username, password, confirmPassword })
    });

    if (res && res.ok && res.json && res.json.ok) {
        window.location.href = `${window.SR_BASE}/dashboard`;
        return;
    }

    err.textContent = (res && res.json && res.json.error) ? res.json.error : "Setup failed.";
    err.style.display = "block";
};
