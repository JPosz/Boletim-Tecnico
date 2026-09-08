(() => {
  "use strict";

  const LOCAL_KEY = "boletim-tecnico-v1";
  const SESSION_KEY = "boletim-cloud-session-v1";
  const BASE_KEY = "boletim-cloud-base-v4";
  const DIRTY_KEY = "boletim-cloud-dirty-v4";
  const VERSION_KEY = "boletim-cloud-version-v4";
  const DB_NAME = "boletim-tecnico-persist";
  const DB_STORE = "auth";
  const DB_SESSION_KEY = "supabase-session";
  const SUPABASE_URL = "https://qdkysernznhbyvcxdrnh.supabase.co";
  const API_KEY = "sb_publishable_-4fGJcPedymP3ILk-z_-pw_8kVqyHvu";
  const APP_URL = "https://jposz.github.io/Boletim-Tecnico/";

  let confirmedFromRedirect = false;
  let session = captureRedirectSession() || loadLocalSession();
  let syncBusy = false;
  let applyingRemote = false;
  let localTimer = null;
  let lastLocalSignature = signatureFromRaw(get(LOCAL_KEY));

  function get(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function set(key, value) { try { localStorage.setItem(key, value); } catch {} }
  function del(key) { try { localStorage.removeItem(key); } catch {} }
  function parse(value) { try { return value ? JSON.parse(value) : null; } catch { return null; } }
  function fmt(value) { try { return new Date(value).toLocaleString("pt-BR"); } catch { return value || ""; } }

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }

  function signature(value) { return stableStringify(value); }
  function signatureFromRaw(value) { const obj = parse(value); return obj ? signature(obj) : ""; }
  function same(a, b) { return signature(a) === signature(b); }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB indisponível"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Falha no IndexedDB"));
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function idbDel(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  function decodeJwt(token) {
    try {
      const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = part + "=".repeat((4 - part.length % 4) % 4);
      return JSON.parse(decodeURIComponent(Array.from(atob(padded)).map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")));
    } catch { return {}; }
  }

  function captureRedirectSession() {
    try {
      if (!location.hash.includes("access_token=")) return null;
      const p = new URLSearchParams(location.hash.slice(1));
      const access_token = p.get("access_token");
      const refresh_token = p.get("refresh_token");
      if (!access_token || !refresh_token) return null;
      const value = { access_token, refresh_token, token_type: p.get("token_type") || "bearer", expires_in: Number(p.get("expires_in") || 3600) };
      persistSession(value);
      confirmedFromRedirect = true;
      history.replaceState(null, document.title, location.pathname + location.search);
      return value;
    } catch { return null; }
  }

  function loadLocalSession() { try { return JSON.parse(get(SESSION_KEY) || "null"); } catch { return null; } }

  function persistSession(value) {
    session = value;
    if (value) {
      set(SESSION_KEY, JSON.stringify(value));
      idbSet(DB_SESSION_KEY, value).catch(() => {});
    } else {
      del(SESSION_KEY);
      idbDel(DB_SESSION_KEY).catch(() => {});
    }
    updateUI();
  }

  async function recoverSession() {
    if (session?.access_token) return;
    try {
      const value = await idbGet(DB_SESSION_KEY);
      if (value?.access_token) {
        session = value;
        set(SESSION_KEY, JSON.stringify(value));
      }
    } catch {}
  }

  function uid() { return decodeJwt(session?.access_token || "").sub || null; }
  function email() { return session?.user?.email || decodeJwt(session?.access_token || "").email || ""; }

  async function api(path, { method = "GET", body, auth = false, headers = {} } = {}) {
    const h = { apikey: API_KEY, ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (auth && session?.access_token) h.Authorization = `Bearer ${session.access_token}`;

    const response = await fetch(SUPABASE_URL + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const error = new Error(data?.msg || data?.message || data?.error_description || data?.error || `Erro ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function ensureSession(force = false) {
    if (!session?.access_token) return false;
    const exp = Number(decodeJwt(session.access_token).exp || 0) * 1000;
    if (!force && exp > Date.now() + 60000) return true;
    if (!session.refresh_token) return false;

    try {
      const refreshed = await api("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: session.refresh_token }
      });
      persistSession(refreshed);
      return true;
    } catch (e) {
      if (e.status === 400 || e.status === 401) persistSession(null);
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
    if (!signed) {
      setStatus("Não conectado.");
      showConflict(false);
    }
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
      #cloudAuthForm[hidden],#cloudSignedActions[hidden],#cloudConflictActions[hidden]{display:none!important}
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
        <span style="width:100%;font-size:.78rem;color:var(--muted)">Este aparelho e a nuvem estão diferentes. Escolha qual versão deve virar a base:</span>
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
    return {
      email: document.getElementById("cloudEmail")?.value.trim() || "",
      password: document.getElementById("cloudPassword")?.value || ""
    };
  }

  async function login() {
    const c = credentials();
    if (!c.email || !c.password) return alert("Digite o e-mail e a senha.");
    setStatus("Entrando...", "warn");
    try {
      const value = await api("/auth/v1/token?grant_type=password", { method: "POST", body: c });
      persistSession(value);
      setStatus("Login salvo. Verificando nuvem...", "ok");
      await reconcile(true);
    } catch (e) {
      setStatus("Falha ao entrar.", "warn");
      alert("Não foi possível entrar: " + e.message);
    }
  }

  async function signup() {
    const c = credentials();
    if (!c.email || c.password.length < 6) return alert("Use um e-mail válido e uma senha com pelo menos 6 caracteres.");
    setStatus("Criando conta...", "warn");
    try {
      const data = await api(`/auth/v1/signup?redirect_to=${encodeURIComponent(APP_URL)}`, { method: "POST", body: c });
      if (data?.access_token) {
        persistSession(data);
        await reconcile(true);
      } else {
        setStatus("Conta criada. Confirme seu e-mail.", "ok");
        alert("Conta criada. Confira seu e-mail para confirmar o cadastro.");
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
    persistSession(null);
    setStatus("Desconectado deste aparelho.");
  }

  function hasMeaningfulLocalData(obj) {
    if (!obj || typeof obj !== "object") return false;
    try {
      for (const tri of Object.values(obj.notes || {})) {
        for (const arr of Object.values(tri || {})) {
          if (Array.isArray(arr) && arr.some(v => String(v ?? "").trim() !== "")) return true;
        }
      }
      for (const value of Object.values(obj.methods || {})) if (value !== "f1") return true;
    } catch {}
    return false;
  }

  async function getRemote() {
    if (!await ensureSession(false)) return null;
    const rows = await api(`/rest/v1/boletins?select=dados,updated_at&user_id=eq.${encodeURIComponent(uid())}&limit=1`, { auth: true });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  function saveCloudMetadata(obj, version) {
    set(BASE_KEY, JSON.stringify(obj));
    set(VERSION_KEY, version || "");
    set(DIRTY_KEY, "0");
  }

  async function pushLocalObject(obj) {
    if (!navigator.onLine || !await ensureSession(false)) return null;
    setStatus("Enviando alterações...", "warn");

    const rows = await api("/rest/v1/boletins?on_conflict=user_id&select=dados,updated_at", {
      method: "POST",
      auth: true,
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: { user_id: uid(), dados: obj }
    });

    const row = Array.isArray(rows) ? rows[0] : null;
    const finalObj = row?.dados || obj;
    const version = row?.updated_at || new Date().toISOString();
    saveCloudMetadata(finalObj, version);
    lastLocalSignature = signatureFromRaw(get(LOCAL_KEY));
    showConflict(false);
    setStatus(`Sincronizado em ${fmt(version)}`, "ok");
    return { obj: finalObj, version };
  }

  function mergeChanges(base, local, remote) {
    if (same(local, base)) return remote;
    const baseObj = base && typeof base === "object";
    const localObj = local && typeof local === "object";
    const remoteObj = remote && typeof remote === "object";
    if (!baseObj || !localObj || !remoteObj) return local;

    if (Array.isArray(base) || Array.isArray(local) || Array.isArray(remote)) {
      if (!(Array.isArray(base) && Array.isArray(local) && Array.isArray(remote))) return local;
      const length = Math.max(base.length, local.length, remote.length);
      return Array.from({ length }, (_, i) => mergeChanges(base[i], local[i], remote[i]));
    }

    const out = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    keys.forEach(key => { out[key] = mergeChanges(base[key], local[key], remote[key]); });
    return out;
  }

  function applyCloud(obj, version, message) {
    const cloudRaw = JSON.stringify(obj);
    applyingRemote = true;
    set(LOCAL_KEY, cloudRaw);
    saveCloudMetadata(obj, version);
    lastLocalSignature = signature(obj);
    applyingRemote = false;
    showConflict(false);
    setStatus(message || `Atualizado da nuvem em ${fmt(version)}`, "ok");
    setTimeout(() => location.reload(), 180);
  }

  async function forcePush() {
    const local = parse(get(LOCAL_KEY));
    if (!local) return;
    try { await pushLocalObject(local); }
    catch (e) { setStatus("Falha ao enviar este aparelho.", "warn"); alert(e.message); }
  }

  async function forcePull() {
    try {
      const remote = await getRemote();
      if (remote) applyCloud(remote.dados, remote.updated_at);
    } catch (e) { setStatus("Falha ao baixar a nuvem.", "warn"); alert(e.message); }
  }

  async function reconcile(manual = false) {
    if (syncBusy || !session?.access_token) return;
    if (!navigator.onLine) {
      if (manual) setStatus("Sem internet. Os dados continuam salvos neste aparelho.", "warn");
      return;
    }

    syncBusy = true;
    try {
      let remote;
      try {
        remote = await getRemote();
      } catch (e) {
        if (e.status === 401 && await ensureSession(true)) remote = await getRemote();
        else throw e;
      }

      const local = parse(get(LOCAL_KEY));
      const base = parse(get(BASE_KEY));
      const knownVersion = get(VERSION_KEY);
      const dirty = get(DIRTY_KEY) === "1";

      if (!remote) {
        if (local) await pushLocalObject(local);
        else setStatus("Conectado. Ainda não há notas para sincronizar.", "ok");
        return;
      }

      if (!local) {
        applyCloud(remote.dados, remote.updated_at);
        return;
      }

      if (!knownVersion) {
        if (same(local, remote.dados)) {
          saveCloudMetadata(remote.dados, remote.updated_at);
          setStatus(`Sincronizado em ${fmt(remote.updated_at)}`, "ok");
        } else if (!hasMeaningfulLocalData(local)) {
          applyCloud(remote.dados, remote.updated_at);
        } else {
          setStatus("Primeira sincronização desta versão: escolha qual estado deve ser mantido.", "warn");
          showConflict(true);
        }
        return;
      }

      const cloudChanged = remote.updated_at !== knownVersion;

      if (dirty) {
        let toPush = local;
        if (cloudChanged && base) toPush = mergeChanges(base, local, remote.dados);
        const result = await pushLocalObject(toPush);
        if (result && !same(result.obj, local)) {
          applyCloud(result.obj, result.version, "Alterações mescladas e sincronizadas.");
        }
        return;
      }

      if (cloudChanged) {
        if (same(local, remote.dados)) {
          saveCloudMetadata(remote.dados, remote.updated_at);
          setStatus(`Sincronizado em ${fmt(remote.updated_at)}`, "ok");
        } else {
          applyCloud(remote.dados, remote.updated_at);
        }
        return;
      }

      setStatus(`Sincronizado em ${fmt(remote.updated_at)}`, "ok");
    } catch (e) {
      console.error("Erro de sincronização:", e);
      setStatus("Não foi possível sincronizar agora. Os dados locais estão seguros.", "warn");
    } finally {
      syncBusy = false;
    }
  }

  function detectLocalChange() {
    if (applyingRemote) return;
    const current = signatureFromRaw(get(LOCAL_KEY));
    if (!current || current === lastLocalSignature) return;
    lastLocalSignature = current;
    set(DIRTY_KEY, "1");
    clearTimeout(localTimer);
    localTimer = setTimeout(() => reconcile(false), 350);
  }

  function installChangeDetection() {
    setInterval(detectLocalChange, 400);

    const scheduleAfterAppSave = () => {
      clearTimeout(localTimer);
      localTimer = setTimeout(() => {
        detectLocalChange();
        reconcile(false);
      }, 450);
    };

    document.addEventListener("input", e => {
      if (e.target?.matches?.(".note-input")) scheduleAfterAppSave();
    }, true);

    document.addEventListener("change", e => {
      if (e.target?.matches?.("[data-method-subject], .note-input")) scheduleAfterAppSave();
    }, true);

    document.addEventListener("click", e => {
      if (e.target?.closest?.("[data-add-note], [data-remove-note], .reset-btn")) scheduleAfterAppSave();
    }, true);
  }

  async function start() {
    injectUI();
    try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
    await recoverSession();
    updateUI();
    installChangeDetection();

    if (confirmedFromRedirect) setStatus("E-mail confirmado. Sincronizando...", "ok");
    if (session?.access_token) await reconcile(true);

    window.addEventListener("online", () => reconcile(true));
    window.addEventListener("focus", () => reconcile(false));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reconcile(false);
    });

    setInterval(() => reconcile(false), 2500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();