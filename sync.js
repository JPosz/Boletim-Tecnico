(() => {
  "use strict";

  const LOCAL_KEY = "boletim-tecnico-v1";
  const LOCAL_UPDATED_KEY = LOCAL_KEY + "-cloud-updated-at";
  const SESSION_KEY = "boletim-cloud-session-v1";
  const SUPABASE_URL = "https://qdkysernznhbyvcxdrnh.supabase.co";
  const API_KEY = "sb_publishable_-4fGJcPedymP3ILk-z_-pw_8kVqyHvu";

  let session = loadSession();
  let lastLocalSnapshot = safeGet(LOCAL_KEY);
  let localChangeTimer = null;
  let applyingRemote = false;
  let syncBusy = false;

  function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function safeSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
  function safeRemove(key) { try { localStorage.removeItem(key); } catch {} }
  function fmt(value) { try { return new Date(value).toLocaleString("pt-BR"); } catch { return value || ""; } }

  function decodeJwt(token) {
    try {
      const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
      return JSON.parse(decodeURIComponent(Array.from(atob(padded)).map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")));
    } catch { return {}; }
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
  }

  function saveSession(value) {
    session = value;
    if (value) safeSet(SESSION_KEY, JSON.stringify(value)); else safeRemove(SESSION_KEY);
    updateUI();
  }

  function userId() { return session?.access_token ? decodeJwt(session.access_token).sub : null; }
  function userEmail() { return session?.user?.email || decodeJwt(session?.access_token || "").email || ""; }
  function tokenExpiredSoon() {
    if (!session?.access_token) return true;
    const exp = Number(decodeJwt(session.access_token).exp || 0) * 1000;
    return !exp || exp < Date.now() + 60000;
  }

  async function api(path, { method = "GET", body, auth = false, headers = {} } = {}) {
    const finalHeaders = { apikey: API_KEY, ...headers };
    if (body !== undefined) finalHeaders["Content-Type"] = "application/json";
    if (auth && session?.access_token) finalHeaders.Authorization = `Bearer ${session.access_token}`;
    const response = await fetch(SUPABASE_URL + path, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const message = data?.msg || data?.message || data?.error_description || data?.error || `Erro ${response.status}`;
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  async function refreshSessionIfNeeded() {
    if (!session?.refresh_token) return !!session?.access_token;
    if (!tokenExpiredSoon()) return true;
    try {
      const data = await api("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: session.refresh_token }
      });
      saveSession(data);
      return true;
    } catch (e) {
      console.warn("Sessão expirada:", e);
      saveSession(null);
      return false;
    }
  }

  function setStatus(text, kind = "") {
    const el = document.getElementById("cloudSyncStatus");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
  }

  function updateUI() {
    const signed = !!session?.access_token;
    const form = document.getElementById("cloudAuthForm");
    const actions = document.getElementById("cloudSignedActions");
    const who = document.getElementById("cloudUser");
    if (form) form.hidden = signed;
    if (actions) actions.hidden = !signed;
    if (who) who.textContent = signed ? userEmail() : "";
    if (!signed) setStatus("Não conectado.");
  }

  function injectUI() {
    if (document.getElementById("cloudSyncPanel")) return;
    const target = document.getElementById("backupInfo") || document.querySelector(".masthead");
    if (!target) return;

    const style = document.createElement("style");
    style.textContent = `
      #cloudSyncPanel{margin-top:12px;padding:12px;border:1px dashed rgba(37,48,56,.28);background:rgba(82,109,120,.05)}
      #cloudSyncPanel .cloud-head{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}
      #cloudSyncPanel .cloud-status,#cloudSyncPanel .cloud-user{font-size:.78rem;color:var(--muted)}
      #cloudSyncPanel .cloud-status[data-kind="ok"],#cloudSyncPanel .cloud-user{color:var(--green)}
      #cloudSyncPanel .cloud-status[data-kind="warn"]{color:var(--copper-dark)}
      #cloudSyncPanel .cloud-form{display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;margin-top:10px}
      #cloudSyncPanel input{border:1px solid rgba(37,48,56,.35);background:#fffaf1;color:var(--ink);padding:9px 10px;min-width:0;font:inherit}
      #cloudSyncPanel .cloud-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
      @media(max-width:760px){#cloudSyncPanel .cloud-form{grid-template-columns:1fr}#cloudSyncPanel .cloud-form button{width:100%}}
    `;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "cloudSyncPanel";
    panel.innerHTML = `
      <div class="cloud-head">
        <div><strong>Sincronização PC ↔ celular</strong><div class="cloud-status" id="cloudSyncStatus">Não conectado.</div></div>
        <div class="cloud-user" id="cloudUser"></div>
      </div>
      <div class="cloud-form" id="cloudAuthForm">
        <input id="cloudEmail" type="email" autocomplete="email" placeholder="E-mail" />
        <input id="cloudPassword" type="password" autocomplete="current-password" minlength="6" placeholder="Senha" />
        <button class="action-btn primary" id="cloudLogin">Entrar</button>
        <button class="action-btn" id="cloudSignup">Criar conta</button>
      </div>
      <div class="cloud-actions" id="cloudSignedActions" hidden>
        <button class="action-btn primary" id="cloudSyncNow">Sincronizar agora</button>
        <button class="action-btn" id="cloudLogout">Sair</button>
      </div>`;
    target.insertAdjacentElement("afterend", panel);

    document.getElementById("cloudLogin").addEventListener("click", login);
    document.getElementById("cloudSignup").addEventListener("click", signup);
    document.getElementById("cloudLogout").addEventListener("click", logout);
    document.getElementById("cloudSyncNow").addEventListener("click", () => reconcile(true));
    updateUI();
  }

  function credentials() {
    return {
      email: document.getElementById("cloudEmail")?.value.trim() || "",
      password: document.getElementById("cloudPassword")?.value || ""
    };
  }

  async function login() {
    const { email, password } = credentials();
    if (!email || !password) return alert("Digite o e-mail e a senha.");
    setStatus("Entrando...", "warn");
    try {
      const data = await api("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
      saveSession(data);
      await reconcile(false);
    } catch (e) {
      setStatus("Falha ao entrar.", "warn");
      alert("Não foi possível entrar: " + e.message);
    }
  }

  async function signup() {
    const { email, password } = credentials();
    if (!email || password.length < 6) return alert("Use um e-mail válido e uma senha com pelo menos 6 caracteres.");
    setStatus("Criando conta...", "warn");
    try {
      const data = await api("/auth/v1/signup", { method: "POST", body: { email, password } });
      if (data?.access_token) {
        saveSession(data);
        await reconcile(false);
      } else {
        setStatus("Conta criada. Confirme seu e-mail e depois entre.", "ok");
        alert("Conta criada. Confira seu e-mail para confirmar o cadastro. Depois volte ao Boletim Técnico e clique em Entrar.");
      }
    } catch (e) {
      setStatus("Falha ao criar conta.", "warn");
      alert("Não foi possível criar a conta: " + e.message);
    }
  }

  async function logout() {
    try {
      if (session?.access_token) await api("/auth/v1/logout?scope=local", { method: "POST", auth: true });
    } catch {}
    saveSession(null);
    setStatus("Desconectado deste aparelho.");
  }

  async function getRemote() {
    await refreshSessionIfNeeded();
    const uid = userId();
    if (!uid) return null;
    const rows = await api(`/rest/v1/boletins?select=dados,updated_at&user_id=eq.${encodeURIComponent(uid)}&limit=1`, {
      auth: true,
      headers: { Accept: "application/json" }
    });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function pushLocal() {
    if (!navigator.onLine || !session?.access_token) return;
    const raw = safeGet(LOCAL_KEY);
    if (!raw) return;
    await refreshSessionIfNeeded();
    const uid = userId();
    if (!uid) return;
    let dados;
    try { dados = JSON.parse(raw); } catch { return; }
    setStatus("Enviando alterações...", "warn");
    const rows = await api("/rest/v1/boletins?on_conflict=user_id&select=updated_at", {
      method: "POST",
      auth: true,
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: { user_id: uid, dados }
    });
    const stamp = Array.isArray(rows) && rows[0]?.updated_at ? rows[0].updated_at : new Date().toISOString();
    safeSet(LOCAL_UPDATED_KEY, stamp);
    lastLocalSnapshot = raw;
    setStatus(`Sincronizado em ${fmt(stamp)}`, "ok");
  }

  async function pullRemote(remote) {
    if (!remote?.dados) return;
    applyingRemote = true;
    const raw = JSON.stringify(remote.dados);
    safeSet(LOCAL_KEY, raw);
    safeSet(LOCAL_UPDATED_KEY, remote.updated_at || new Date().toISOString());
    lastLocalSnapshot = raw;
    applyingRemote = false;
    setStatus(`Atualizado da nuvem em ${fmt(remote.updated_at)}`, "ok");
    setTimeout(() => location.reload(), 250);
  }

  async function reconcile(manual = false) {
    if (syncBusy || !session?.access_token || !navigator.onLine) {
      if (manual && !navigator.onLine) setStatus("Sem internet. Seus dados continuam salvos neste aparelho.", "warn");
      return;
    }
    syncBusy = true;
    try {
      setStatus("Comparando versões...", "warn");
      const remote = await getRemote();
      const localRaw = safeGet(LOCAL_KEY);
      const localStamp = Date.parse(safeGet(LOCAL_UPDATED_KEY) || 0) || 0;
      const remoteStamp = Date.parse(remote?.updated_at || 0) || 0;

      if (!remote) {
        if (localRaw) await pushLocal();
        else setStatus("Conectado. Ainda não há notas para sincronizar.", "ok");
      } else if (!localRaw || remoteStamp > localStamp) {
        await pullRemote(remote);
      } else if (localStamp > remoteStamp) {
        await pushLocal();
      } else {
        setStatus(`Sincronizado em ${fmt(remote.updated_at)}`, "ok");
      }
    } catch (e) {
      console.error("Erro de sincronização:", e);
      if (e.status === 401) saveSession(null);
      setStatus("Não foi possível sincronizar agora. Os dados locais estão seguros.", "warn");
    } finally {
      syncBusy = false;
    }
  }

  function watchLocalChanges() {
    setInterval(() => {
      const current = safeGet(LOCAL_KEY);
      if (applyingRemote || current === lastLocalSnapshot) return;
      lastLocalSnapshot = current;
      safeSet(LOCAL_UPDATED_KEY, new Date().toISOString());
      if (!session?.access_token) return;
      clearTimeout(localChangeTimer);
      localChangeTimer = setTimeout(pushLocal, 900);
    }, 500);
  }

  async function start() {
    injectUI();
    watchLocalChanges();
    if (session?.access_token) {
      updateUI();
      await reconcile(false);
    }
    window.addEventListener("online", () => reconcile(false));
    window.addEventListener("focus", () => reconcile(false));
    setInterval(() => reconcile(false), 12000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
