(() => {
  "use strict";

  const LOCAL_KEY = "boletim-tecnico-v1";
  const SESSION_KEY = "boletim-cloud-session-v1";
  const BASE_KEY = "boletim-cloud-base-v2";
  const DIRTY_KEY = "boletim-cloud-dirty-v2";
  const SUPABASE_URL = "https://qdkysernznhbyvcxdrnh.supabase.co";
  const API_KEY = "sb_publishable_-4fGJcPedymP3ILk-z_-pw_8kVqyHvu";
  const APP_URL = "https://jposz.github.io/Boletim-Tecnico/";

  let confirmedFromRedirect = false;
  let session = captureRedirectSession() || loadSession();
  let lastLocalSnapshot = get(LOCAL_KEY);
  let syncBusy = false;
  let applyingRemote = false;
  let changeTimer = null;

  function get(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch {} }
  function del(k) { try { localStorage.removeItem(k); } catch {} }
  function raw(obj) { return JSON.stringify(obj); }
  function same(a, b) { return raw(a) === raw(b); }
  function fmt(v) { try { return new Date(v).toLocaleString("pt-BR"); } catch { return v || ""; } }

  function captureRedirectSession() {
    try {
      if (!location.hash.includes("access_token=")) return null;
      const p = new URLSearchParams(location.hash.slice(1));
      const access_token = p.get("access_token");
      const refresh_token = p.get("refresh_token");
      if (!access_token || !refresh_token) return null;
      const s = { access_token, refresh_token, token_type: p.get("token_type") || "bearer", expires_in: Number(p.get("expires_in") || 3600) };
      set(SESSION_KEY, JSON.stringify(s));
      confirmedFromRedirect = true;
      history.replaceState(null, document.title, location.pathname + location.search);
      return s;
    } catch { return null; }
  }

  function decodeJwt(token) {
    try {
      const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = part + "=".repeat((4 - part.length % 4) % 4);
      return JSON.parse(decodeURIComponent(Array.from(atob(padded)).map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")));
    } catch { return {}; }
  }

  function loadSession() { try { return JSON.parse(get(SESSION_KEY) || "null"); } catch { return null; } }
  function saveSession(s) { session = s; s ? set(SESSION_KEY, JSON.stringify(s)) : del(SESSION_KEY); updateUI(); }
  function uid() { return decodeJwt(session?.access_token || "").sub || null; }
  function email() { return session?.user?.email || decodeJwt(session?.access_token || "").email || ""; }

  async function api(path, { method = "GET", body, auth = false, headers = {} } = {}) {
    const h = { apikey: API_KEY, ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (auth && session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
    const r = await fetch(SUPABASE_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const e = new Error(data?.msg || data?.message || data?.error_description || data?.error || `Erro ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  }

  async function refreshIfNeeded() {
    if (!session?.access_token) return false;
    const exp = Number(decodeJwt(session.access_token).exp || 0) * 1000;
    if (exp > Date.now() + 60000) return true;
    if (!session.refresh_token) return false;
    try {
      const s = await api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: session.refresh_token } });
      saveSession(s);
      return true;
    } catch {
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

  function showConflict(show) {
    const el = document.getElementById("cloudConflictActions");
    if (el) el.hidden = !show;
  }

  function updateUI() {
    const signed = !!session?.access_token;
    const form = document.getElementById("cloudAuthForm");
    const actions = document.getElementById("cloudSignedActions");
    const who = document.getElementById("cloudUser");
    if (form) form.hidden = signed;
    if (actions) actions.hidden = !signed;
    if (who) who.textContent = signed ? email() : "";
    if (!signed) { setStatus("Não conectado."); showConflict(false); }
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
      #cloudConflictActions{margin-top:8px;padding-top:8px;border-top:1px dashed rgba(37,48,56,.25)}
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
      </div>
      <div class="cloud-actions" id="cloudConflictActions" hidden>
        <span style="width:100%;font-size:.78rem;color:var(--muted)">Há dados diferentes neste aparelho e na nuvem. Escolha qual versão deve ser usada como base:</span>
        <button class="action-btn primary" id="cloudKeepLocal">Manter este aparelho</button>
        <button class="action-btn" id="cloudUseCloud">Usar versão da nuvem</button>
      </div>`;
    target.insertAdjacentElement("afterend", panel);

    document.getElementById("cloudLogin").onclick = login;
    document.getElementById("cloudSignup").onclick = signup;
    document.getElementById("cloudLogout").onclick = logout;
    document.getElementById("cloudSyncNow").onclick = () => reconcile(true);
    document.getElementById("cloudKeepLocal").onclick = forcePush;
    document.getElementById("cloudUseCloud").onclick = forcePull;
    updateUI();
  }

  function credentials() {
    return { email: document.getElementById("cloudEmail")?.value.trim() || "", password: document.getElementById("cloudPassword")?.value || "" };
  }

  async function login() {
    const c = credentials();
    if (!c.email || !c.password) return alert("Digite o e-mail e a senha.");
    setStatus("Entrando...", "warn");
    try {
      saveSession(await api("/auth/v1/token?grant_type=password", { method: "POST", body: c }));
      await reconcile(false);
    } catch (e) { setStatus("Falha ao entrar.", "warn"); alert("Não foi possível entrar: " + e.message); }
  }

  async function signup() {
    const c = credentials();
    if (!c.email || c.password.length < 6) return alert("Use um e-mail válido e uma senha com pelo menos 6 caracteres.");
    setStatus("Criando conta...", "warn");
    try {
      const data = await api(`/auth/v1/signup?redirect_to=${encodeURIComponent(APP_URL)}`, { method: "POST", body: c });
      if (data?.access_token) { saveSession(data); await reconcile(false); }
      else { setStatus("Conta criada. Confirme seu e-mail.", "ok"); alert("Conta criada. Confira seu e-mail para confirmar o cadastro."); }
    } catch (e) { setStatus("Falha ao criar conta.", "warn"); alert("Não foi possível criar a conta: " + e.message); }
  }

  async function logout() {
    try { if (session?.access_token) await api("/auth/v1/logout?scope=local", { method: "POST", auth: true }); } catch {}
    saveSession(null);
  }

  async function getRemote() {
    if (!await refreshIfNeeded()) return null;
    const id = uid();
    const rows = await api(`/rest/v1/boletins?select=dados,updated_at&user_id=eq.${encodeURIComponent(id)}&limit=1`, { auth: true });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function pushObject(obj) {
    if (!navigator.onLine || !await refreshIfNeeded()) return null;
    setStatus("Enviando alterações...", "warn");
    const rows = await api("/rest/v1/boletins?on_conflict=user_id&select=dados,updated_at", {
      method: "POST", auth: true,
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: { user_id: uid(), dados: obj }
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    const finalObj = row?.dados || obj;
    const finalRaw = raw(finalObj);
    set(BASE_KEY, finalRaw);
    set(DIRTY_KEY, "0");
    lastLocalSnapshot = finalRaw;
    showConflict(false);
    setStatus(`Sincronizado${row?.updated_at ? " em " + fmt(row.updated_at) : ""}`, "ok");
    return { obj: finalObj, raw: finalRaw };
  }

  function mergeChanges(base, local, remote) {
    if (same(local, base)) return remote;
    const baseObj = base && typeof base === "object";
    const localObj = local && typeof local === "object";
    const remoteObj = remote && typeof remote === "object";
    if (!baseObj || !localObj || !remoteObj) return local;

    if (Array.isArray(base) || Array.isArray(local) || Array.isArray(remote)) {
      if (!(Array.isArray(base) && Array.isArray(local) && Array.isArray(remote))) return local;
      const n = Math.max(base.length, local.length, remote.length);
      return Array.from({ length: n }, (_, i) => mergeChanges(base[i], local[i], remote[i]));
    }

    const out = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    keys.forEach(k => { out[k] = mergeChanges(base[k], local[k], remote[k]); });
    return out;
  }

  async function pullRemote(remote) {
    if (!remote?.dados) return;
    const r = raw(remote.dados);
    applyingRemote = true;
    set(LOCAL_KEY, r);
    set(BASE_KEY, r);
    set(DIRTY_KEY, "0");
    lastLocalSnapshot = r;
    applyingRemote = false;
    showConflict(false);
    setStatus(`Atualizado da nuvem${remote.updated_at ? " em " + fmt(remote.updated_at) : ""}`, "ok");
    setTimeout(() => location.reload(), 180);
  }

  async function forcePush() {
    try {
      const localRaw = get(LOCAL_KEY);
      if (!localRaw) return;
      await pushObject(JSON.parse(localRaw));
    } catch (e) { setStatus("Falha ao enviar este aparelho.", "warn"); alert(e.message); }
  }

  async function forcePull() {
    try {
      const remote = await getRemote();
      if (remote) await pullRemote(remote);
    } catch (e) { setStatus("Falha ao baixar a nuvem.", "warn"); alert(e.message); }
  }

  async function reconcile(manual = false) {
    if (syncBusy || !session?.access_token) return;
    if (!navigator.onLine) { if (manual) setStatus("Sem internet. Os dados continuam salvos neste aparelho.", "warn"); return; }
    syncBusy = true;
    try {
      const remote = await getRemote();
      const localRaw = get(LOCAL_KEY);
      const baseRaw = get(BASE_KEY);
      const local = localRaw ? JSON.parse(localRaw) : null;
      const base = baseRaw ? JSON.parse(baseRaw) : null;
      const remoteObj = remote?.dados || null;
      const remoteRaw = remoteObj ? raw(remoteObj) : null;

      if (!remote) {
        if (local) await pushObject(local);
        else setStatus("Conectado. Ainda não há notas para sincronizar.", "ok");
        return;
      }

      if (!local) { await pullRemote(remote); return; }

      if (!base) {
        if (localRaw === remoteRaw) {
          set(BASE_KEY, localRaw);
          set(DIRTY_KEY, "0");
          setStatus(`Sincronizado${remote.updated_at ? " em " + fmt(remote.updated_at) : ""}`, "ok");
        } else {
          setStatus("Encontrei versões diferentes. Escolha qual deve ser a base.", "warn");
          showConflict(true);
        }
        return;
      }

      const inferredDirty = get(DIRTY_KEY) === "1" || localRaw !== baseRaw;
      const remoteChanged = remoteRaw !== baseRaw;

      if (inferredDirty) {
        const merged = remoteChanged ? mergeChanges(base, local, remoteObj) : local;
        const before = localRaw;
        const pushed = await pushObject(merged);
        if (pushed && pushed.raw !== before) {
          applyingRemote = true;
          set(LOCAL_KEY, pushed.raw);
          lastLocalSnapshot = pushed.raw;
          applyingRemote = false;
          setTimeout(() => location.reload(), 180);
        }
      } else if (remoteChanged) {
        await pullRemote(remote);
      } else {
        setStatus(`Sincronizado${remote.updated_at ? " em " + fmt(remote.updated_at) : ""}`, "ok");
      }
    } catch (e) {
      console.error("Erro de sincronização:", e);
      if (e.status === 401) saveSession(null);
      else setStatus("Não foi possível sincronizar agora. Os dados locais estão seguros.", "warn");
    } finally { syncBusy = false; }
  }

  function watchLocal() {
    setInterval(() => {
      const current = get(LOCAL_KEY);
      if (current === lastLocalSnapshot) return;
      lastLocalSnapshot = current;
      if (applyingRemote) return;
      set(DIRTY_KEY, "1");
      if (!session?.access_token) return;
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => reconcile(false), 700);
    }, 350);
  }

  async function start() {
    injectUI();
    watchLocal();
    if (confirmedFromRedirect) setStatus("E-mail confirmado. Sincronizando...", "ok");
    if (session?.access_token) { updateUI(); await reconcile(false); }
    window.addEventListener("online", () => reconcile(false));
    window.addEventListener("focus", () => reconcile(false));
    setInterval(() => reconcile(false), 3000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();