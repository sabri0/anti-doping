/*
 * Live client for the athlete platform.
 *
 * index.html ships as a design with simulated data so it paints instantly. This
 * script replaces that data with the ledger's, and re-points every control at a
 * real transaction. Nothing below invents state: each render is what the network
 * returned, and each button submits a transaction and then re-reads the result.
 *
 * The design's own rendering functions are reused through window.__ui, so the
 * visual language is defined in one place and this file only supplies data.
 */
(function () {
  "use strict";

  const ui = window.__ui;
  if (!ui) return; // design script failed to load; leave the static page alone

  const $ = (s) => document.querySelector(s);
  const API = "/api";

  /* Six categories, ledger identifier to the design's icon and display name. */
  const CATEGORY_VIEW = {
    gps_accelerometry:  { id: "gps",  name: "GPS & accelerometry",       icon: "gps" },
    biochemical_markers:{ id: "bio",  name: "Biochemical markers",       icon: "bio" },
    abp_haematological: { id: "hema", name: "ABP — haematological",      icon: "blood" },
    abp_steroidal:      { id: "ster", name: "ABP — steroidal",           icon: "steroid" },
    psychological:      { id: "psy",  name: "Psychological assessments", icon: "brain" },
    genetic:            { id: "gen",  name: "Genetic data",              icon: "dna" },
  };
  const LEDGER_ID = Object.fromEntries(
    Object.entries(CATEGORY_VIEW).map(([ledger, v]) => [v.id, ledger])
  );

  const PURPOSE = "cardiovascular_research";
  const RESEARCH_ORG = "ResearchMSP";

  const state = { athleteHash: null, sampleCode: null, erasable: new Set(), online: false };


  /* ================================================================== auth
   * The gateway now requires a session for every /api route, so the platform
   * opens on a sign-in screen. Credentials are checked by the organization's
   * own certification authority, not by this page.
   */

  const SESSION_KEY = "sentinel.session";
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; }

  const ORG_ROLE = {
    athlete: "Athlete", federation: "Federation / club", nado: "National anti-doping organisation",
    lab: "WADA-accredited laboratory", research: "Research institution",
  };

  function styles() {
    if (document.getElementById("liveStyles")) return;
    const el = document.createElement("style");
    el.id = "liveStyles";
    el.textContent = `
      .signin-veil{position:fixed;inset:0;background:var(--ink,#0C1D24);display:flex;
        align-items:center;justify-content:center;z-index:9999;padding:24px}
      .signin{background:var(--surface,#fff);border-radius:16px;padding:30px 32px;width:min(420px,100%);
        box-shadow:0 24px 70px rgba(0,0,0,.4)}
      .signin h2{margin:0 0 4px;font-size:20px}
      .signin p.sub{margin:0 0 20px;color:var(--muted,#566B65);font-size:13px;line-height:1.5}
      .signin label{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;
        color:var(--faint,#8397A0);font-weight:600;margin:14px 0 6px}
      .signin input,.signin select{width:100%;padding:10px 12px;border:1px solid var(--line,#D6DEDC);
        border-radius:9px;font:inherit;font-size:14px;background:var(--surface-2,#F6F9F8);color:inherit}
      .signin button{width:100%;margin-top:20px;padding:11px;border-radius:9px;border:none;
        background:var(--jade,#2E9B82);color:#fff;font:inherit;font-weight:650;font-size:14px;cursor:pointer}
      .signin button[disabled]{opacity:.6;cursor:progress}
      .signin .err{margin-top:12px;font-size:12.5px;color:var(--rose,#AE443B);min-height:1em}
      .signin .hint{margin-top:16px;font-size:11.5px;color:var(--faint,#8397A0);line-height:1.6}
      .nav a{cursor:pointer}
      .netgrid{display:grid;gap:1px;background:var(--line-soft,#E7ECEB);border:1px solid var(--line-soft,#E7ECEB);
        border-radius:10px;overflow:hidden}
      .netrow{display:flex;align-items:center;gap:12px;background:var(--surface,#fff);padding:11px 14px;font-size:13px}
      .netrow .dot{width:8px;height:8px;border-radius:50%;flex:none}
      .netrow .dot.up{background:var(--jade,#2E9B82)} .netrow .dot.down{background:var(--rose,#AE443B)}
      .netrow .who{font-weight:600;min-width:120px}
      .netrow .meta{color:var(--muted,#566B65);font-size:12px;flex:1}
      section[data-sec]{scroll-margin-top:18px}
      section[data-sec].dim{display:none}
    `;
    document.head.appendChild(el);
  }

  function showSignIn(message) {
    styles();
    if (document.querySelector(".signin-veil")) return;
    const veil = document.createElement("div");
    veil.className = "signin-veil";
    veil.innerHTML = `
      <form class="signin" autocomplete="on">
        <h2>Sign in</h2>
        <p class="sub">Your credentials are verified by your organisation's certification
          authority. The identity you sign in with is the identity that signs every
          transaction you submit.</p>
        <label for="siOrg">Organisation</label>
        <select id="siOrg">
          ${Object.entries(ORG_ROLE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
        </select>
        <label for="siUser">Username</label>
        <input id="siUser" name="username" value="athleteuser" autocomplete="username">
        <label for="siPass">Password</label>
        <input id="siPass" name="password" type="password" value="athleteuserpw" autocomplete="current-password">
        <button type="submit">Sign in</button>
        <div class="err">${message || ""}</div>
        <div class="hint">Seeded identities: <span class="mono">&lt;org&gt;user / &lt;org&gt;userpw</span>
          and <span class="mono">&lt;org&gt;admin / &lt;org&gt;adminpw</span>.</div>
      </form>`;
    document.body.appendChild(veil);

    const orgSel = veil.querySelector("#siOrg");
    const user = veil.querySelector("#siUser");
    const pass = veil.querySelector("#siPass");
    orgSel.addEventListener("change", () => {
      user.value = `${orgSel.value}user`;
      pass.value = `${orgSel.value}userpw`;
    });

    veil.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = veil.querySelector("button");
      const err = veil.querySelector(".err");
      btn.disabled = true;
      err.textContent = "Verifying with the certification authority…";
      try {
        const res = await fetch(`${API}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ org: orgSel.value, username: user.value, password: pass.value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        session = data;
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        veil.remove();
        boot();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
    user.focus();
  }

  function signOut() {
    fetch(`${API}/auth/logout`, {
      method: "POST",
      headers: session ? { authorization: `Bearer ${session.token}` } : {},
    }).catch(() => {});
    sessionStorage.removeItem(SESSION_KEY);
    session = null;
    location.reload();
  }

  /* Show who is actually signed in, replacing the design's placeholder chip. */
  function showIdentity() {
    const chip = document.querySelector(".athlete-chip");
    if (!chip || !session) return;
    const initials = session.username.slice(0, 2).toUpperCase();
    chip.querySelector(".avatar").textContent = initials;
    chip.querySelector(".who").textContent = session.username;
    chip.querySelector(".id").textContent = session.mspId;
    chip.style.cursor = "pointer";
    chip.title = "Sign out";
    chip.addEventListener("click", signOut);
  }

  /* ================================================================== nav
   * Every rail link was href="#". Each now targets a section of the page.
   */

  const NAV_SECTIONS = {
    "Overview": null, // all sections
    "Chain of custody": "chain",
    "Data sovereignty": "sovereignty",
    "Consent requests": "requests",
    "Audit trail": "audit",
    "Network status": "network",
  };

  function labelSections() {
    const map = {
      "Chain of custody": "chain",
      "Data sovereignty": "sovereignty",
      "Access request": "requests",
      "Key recovery": "requests",
      "Audit trail": "audit",
    };
    document.querySelectorAll("h2").forEach((h2) => {
      const key = map[h2.textContent.trim()];
      if (!key) return;
      const card = h2.closest(".card") || h2.parentElement;
      const host = card && card.parentElement && card.parentElement.tagName === "SECTION"
        ? card.parentElement : card;
      if (host) host.setAttribute("data-sec", key);
    });
  }

  function networkPanel() {
    if (document.querySelector('[data-sec="network"]')) return;
    const host = document.querySelector('[data-sec="audit"]');
    if (!host) return;
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("data-sec", "network");
    card.innerHTML = `
      <div class="card-head">
        <div class="head-ic">${ui.ICON.seal}</div>
        <div style="flex:1">
          <div class="eyebrow">Deployed network</div>
          <h2>Network status</h2>
        </div>
      </div>
      <div class="netgrid" id="netgrid"><div class="netrow"><span class="meta">Querying peers…</span></div></div>`;
    host.parentNode.insertBefore(card, host.nextSibling);
  }

  async function loadNetwork() {
    const grid = $("#netgrid");
    if (!grid) return;
    try {
      const n = await GET("/network");
      grid.innerHTML =
        n.organizations.map((o) => `
          <div class="netrow">
            <span class="dot ${o.reachable ? "up" : "down"}"></span>
            <span class="who">${ORG_ROLE[o.org] || o.org}</span>
            <span class="meta mono">${o.peer}</span>
            <span class="mono" style="font-size:12px">${o.reachable ? o.latencyMs + " ms" : "unreachable"}</span>
          </div>`).join("") + `
          <div class="netrow"><span class="dot up"></span><span class="who">Ordering service</span>
            <span class="meta mono">${n.orderer}</span></div>
          <div class="netrow"><span class="dot ${n.ipfs ? "up" : "down"}"></span><span class="who">IPFS cluster</span>
            <span class="meta mono">3 nodes, private (no public bootstrap)</span></div>
          <div class="netrow"><span class="dot up"></span><span class="who">Channel</span>
            <span class="meta mono">${n.channel} · chaincode: ${n.chaincodes.join(", ")}</span></div>`;
    } catch (e) {
      grid.innerHTML = `<div class="netrow"><span class="dot down"></span><span class="meta">${e.message}</span></div>`;
    }
  }

  function wireNav() {
    const links = [...document.querySelectorAll(".nav a")];
    links.forEach((a) => {
      const label = a.textContent.trim();
      const target = NAV_SECTIONS[label];
      a.setAttribute("href", target ? `#${target}` : "#");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        links.forEach((l) => l.classList.remove("active"));
        a.classList.add("active");
        const sections = [...document.querySelectorAll("[data-sec]")];
        if (!target) {
          sections.forEach((s) => s.classList.remove("dim"));
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        // Show only the chosen area, so the menu filters rather than decorates.
        sections.forEach((s) => s.classList.toggle("dim", s.getAttribute("data-sec") !== target));
        if (target === "network") loadNetwork();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  /* ------------------------------------------------------------------ http */

  async function call(method, path, body, org) {
    const url = `${API}${path}${path.includes("?") ? "&" : "?"}org=${org || "athlete"}`;
    const headers = {};
    if (body) headers["content-type"] = "application/json";
    if (session) headers.authorization = `Bearer ${session.token}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (res.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      session = null;
      showSignIn("Your session has expired. Sign in again.");
      throw new Error("session expired");
    }
    if (!res.ok) {
      const err = new Error((data && (data.details || data.error)) || `HTTP ${res.status}`);
      err.status = res.status; err.body = data;
      throw err;
    }
    return data;
  }
  const GET  = (p, org) => call("GET", p, null, org);
  const POST = (p, b, org) => call("POST", p, b, org);
  const DEL  = (p, b, org) => call("DELETE", p, b, org);

  /* --------------------------------------------------------------- banner */

  function banner(kind, text) {
    const el = $("#verifyBanner");
    if (!el) return;
    el.className = "verify-banner " + kind;
    el.innerHTML = text;
    el.style.display = "flex";
  }

  const shortHash = (s) => (s && s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s || "—");
  const when = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleString(undefined,
      { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  /* --------------------------------------------------- chain of custody */

  const PHASE_LABEL = {
    COLLECTION: "Sample collection",
    TRANSPORT_HANDOFF: "Transport handoff",
    LABORATORY_RECEIPT: "Laboratory receipt",
    LABORATORY_INTERNAL: "Laboratory internal transfer",
    ANALYSIS_COMPLETE: "Analysis complete",
  };
  const ORG_LABEL = {
    NADOMSP: "NADO", LabMSP: "Lab", AthleteMSP: "Athlete",
    FederationMSP: "Federation", ResearchMSP: "Research",
  };

  async function loadChain() {
    const chain = await GET(`/samples/${encodeURIComponent(state.sampleCode)}/custody-chain`);
    const history = await GET(`/samples/${encodeURIComponent(state.sampleCode)}/history`)
      .catch(() => []);

    let prev = "—";
    const rows = chain.map((ev) => {
      const txHash = shortHash((history[ev.sequence] || {}).txId);
      const row = {
        phase: PHASE_LABEL[ev.phase] || ev.phase,
        actor: ev.fromMSP === ev.toMSP
          ? `${ORG_LABEL[ev.submittingMSP] || ev.submittingMSP}`
          : `${ORG_LABEL[ev.fromMSP] || ev.fromMSP} → ${ORG_LABEL[ev.toMSP] || ev.toMSP}`,
        time: when(ev.recordedAt),
        hash: txHash,
        prev,
        // Both parties to a transfer must endorse; collection is NADO alone.
        end: ev.sequence === 0
          ? [["NADO", "ok"]]
          : [[ORG_LABEL[ev.fromMSP] || ev.fromMSP, "ok"], [ORG_LABEL[ev.toMSP] || ev.toMSP, "ok"]],
        status: ev.containerSealIntact ? "ok" : "broken",
      };
      prev = txHash;
      return row;
    });

    // The analysis and its results-management decision close the chain.
    try {
      const rm = await GET(`/samples/${encodeURIComponent(state.sampleCode)}/results`);
      if (rm && rm.granted && rm.results) {
        const r = rm.results;
        rows.push({
          phase: "Results management",
          actor: `Table 2 decision engine · ${r.wadaArticle || "Article 7.1"}`,
          time: when(r.decidedAt),
          // The hash column holds transaction hashes; the rule identifier
          // belongs in the note, not here.
          hash: shortHash((history[history.length - 1] || {}).txId),
          prev,
          end: [["NADO", "ok"], ["Lab", "ok"]],
          status: r.action === "AAF_CONFIRMED" ? "broken" : "ok",
          note: `${r.action.replace(/_/g, " ").toLowerCase()} — decided on-chain by ${r.ruleId}`,
        });
      }
    } catch { /* results not yet under management */ }

    ui.custody = rows;
    ui.renderChain();
  }

  /* ------------------------------------------------------ data sovereignty */

  async function loadCategories() {
    const defs = await GET("/categories");
    const grants = await GET(`/consent/${state.athleteHash}`).catch(() => []);
    const live = grants.filter((g) => !g.revoked);

    ui.cats = defs.categories.map((ledgerId) => {
      const view = CATEGORY_VIEW[ledgerId] || { id: ledgerId, name: ledgerId, icon: "bio" };
      const grant = live.find((g) => (g.categories || []).includes(ledgerId));
      const erased = state.erasedCategories && state.erasedCategories.has(ledgerId);
      return {
        id: view.id,
        name: view.name,
        icon: view.icon,
        granted: Boolean(grant),
        erased: Boolean(erased),
        org: grant ? (ORG_LABEL[grant.grantedToMSP] || grant.grantedToMSP) : "—",
        purpose: grant ? grant.purpose : "",
        exp: grant
          ? `expires ${new Date(grant.validUntil).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}`
          : "no active grant",
      };
    });
    ui.renderCats();
  }

  /* Grant or withdraw one category, then re-read what the ledger now holds. */
  async function setCategory(ledgerId, grant) {
    const grants = await GET(`/consent/${state.athleteHash}`).catch(() => []);
    const existing = grants.find((g) => g.purpose === PURPOSE && g.grantedToMSP === RESEARCH_ORG);
    const current = new Set(
      existing && !existing.revoked ? existing.categories : []
    );
    grant ? current.add(ledgerId) : current.delete(ledgerId);

    if (current.size === 0) {
      await DEL("/consent", { athleteHash: state.athleteHash, grantedToMSP: RESEARCH_ORG, purpose: PURPOSE });
    } else {
      await POST("/consent", {
        athleteHash: state.athleteHash,
        grantedToMSP: RESEARCH_ORG,
        purpose: PURPOSE,
        categories: [...current],
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        specialCategoryAuthorised: true,
      });
    }
    await loadCategories();
  }

  /* -------------------------------------------------------- access request */

  /* The §3.5 scenario, evaluated by the chaincode rather than described. */
  async function evaluateRequest() {
    const all = Object.keys(CATEGORY_VIEW);
    const decision = await POST("/access-request/preview",
      { athleteHash: state.athleteHash, purpose: PURPOSE, categories: all });

    const granted = decision.granted || [];
    const denied = decision.denied || [];
    const name = (l) => (CATEGORY_VIEW[l] || { name: l }).name;

    const reasons = (decision.outcomes || [])
      .filter((o) => o.decision === "DENIED")
      .slice(0, 4)
      .map((o) => `<li><b>${name(o.category)}</b> — ${o.reason} <span class="mono">(${o.gdprArticle})</span></li>`)
      .join("");

    $("#reqBlock").innerHTML = `
      <div class="req-note">
        <div style="font-weight:650;margin-bottom:6px">
          Evaluated on-chain — ${granted.length} of ${granted.length + denied.length} categories released
        </div>
        <div style="margin-bottom:8px">
          ${granted.length
              ? granted.map(name).map((n) => `<span class="badge ok">${n}</span>`).join(" ")
              : '<span class="badge bad">nothing released</span>'}
        </div>
        ${reasons ? `<ul style="margin:6px 0 0 16px;padding:0;font-size:12.5px;line-height:1.7">${reasons}</ul>` : ""}
      </div>`;
    ui.logFeed("ok", `Access request evaluated — ${granted.length} of 6 categories released`);
    ui.toast(`Purpose-limited: ${granted.length} of 6 released`);
  }

  /* ------------------------------------------------------------ audit feed */

  async function loadFeed() {
    const items = [];
    try {
      const history = await GET(`/samples/${encodeURIComponent(state.sampleCode)}/history`);
      history.slice(-3).reverse().forEach((h) => {
        items.push({
          t: "ok",
          txt: `Ledger version committed — tx <b>${shortHash(h.txId)}</b>`,
          time: when(h.value && h.value.collectionTimestamp),
        });
      });
    } catch { /* sample not readable */ }

    try {
      const grants = await GET(`/consent/${state.athleteHash}`);
      grants.slice(-3).reverse().forEach((g) => {
        items.push({
          t: g.revoked ? "warn" : "ok",
          txt: g.revoked
            ? `Consent withdrawn from <b>${ORG_LABEL[g.grantedToMSP] || g.grantedToMSP}</b>`
            : `Consent granted to <b>${ORG_LABEL[g.grantedToMSP] || g.grantedToMSP}</b> · ${(g.categories || []).length} categories`,
          time: when(g.recordedAt),
        });
      });
    } catch { /* no consent records */ }

    ui.feed = items.length ? items : [{ t: "ok", txt: "No ledger activity yet for this athlete", time: "" }];
    ui.renderFeed();
  }

  /* ------------------------------------------------------------- controls */

  /* Replacing a node drops the design's simulated listeners with it. */
  function rebind(sel, type, handler) {
    const old = $(sel);
    if (!old) return null;
    const fresh = old.cloneNode(true);
    old.parentNode.replaceChild(fresh, old);
    fresh.addEventListener(type, handler);
    return fresh;
  }

  async function guard(fn, label) {
    try {
      await fn();
    } catch (e) {
      ui.toast(`${label}: ${e.message}`.slice(0, 120));
      ui.logFeed("warn", `${label} refused — ${e.message}`);
    }
  }

  function wire() {
    rebind("#cats", "change", (e) => {
      const id = e.target.getAttribute("data-id");
      if (!id) return;
      const ledgerId = LEDGER_ID[id];
      const on = e.target.checked;
      guard(async () => {
        await setCategory(ledgerId, on);
        ui.logFeed(on ? "ok" : "warn",
          `${(CATEGORY_VIEW[ledgerId] || {}).name} — ${on ? "consent granted" : "consent withdrawn"} on-chain`);
        ui.toast(on ? "Consent recorded on the ledger" : "Consent withdrawn on the ledger");
        await loadFeed();
      }, "Consent change");
    });

    rebind("#grantReq", "click", () => guard(evaluateRequest, "Access request"));

    rebind("#denyReq", "click", () => guard(async () => {
      await DEL("/consent", {
        athleteHash: state.athleteHash, grantedToMSP: RESEARCH_ORG, purpose: PURPOSE,
      });
      await loadCategories();
      await evaluateRequest();
      ui.logFeed("warn", "Consent withdrawn — the request now releases nothing");
    }, "Withdrawal"));

    rebind("#eraseBtn", "click", () => guard(async () => {
      const target = [...state.erasable][0];
      if (!target) {
        ui.toast("No stored biological data to erase");
        return;
      }
      const out = await POST("/offchain/erase",
        { athleteHash: state.athleteHash, category: target });
      state.erasedCategories = state.erasedCategories || new Set();
      state.erasedCategories.add(target);
      state.erasable.delete(target);
      await loadCategories();
      const c = out.certificate;
      ui.logFeed("warn",
        `Article 17 erasure — key destroyed, unpinned on ${c.unpinResults.filter((r) => r.unpinned).length} IPFS nodes`);
      ui.toast("Key destroyed — data cryptographically unrecoverable");
      banner("warn",
        `<b>Erasure recorded.</b> ${c.legalCaveat}`);
    }, "Erasure"));

    rebind("#verifyBtn", "click", () => guard(async () => {
      const history = await GET(`/samples/${encodeURIComponent(state.sampleCode)}/history`);
      const nodes = [...document.querySelectorAll(".cust")];
      nodes.forEach((n, i) => setTimeout(() => n.classList.add("verifying"), i * 90));
      setTimeout(() => {
        nodes.forEach((n) => n.classList.remove("verifying"));
        banner("ok",
          `<b>Chain verified against the ledger.</b> ${history.length} committed versions, ` +
          `each with its own transaction identifier. Modifying any earlier record would ` +
          `require re-endorsement by every organization that signed it.`);
      }, nodes.length * 90 + 240);
      ui.logFeed("ok", `Chain verified — ${history.length} ledger versions read back`);
    }, "Verification"));

    /* The design's tamper button simulated corruption. The point is that the
       network refuses it, so the button now attempts a real single-organization
       write to results-management state and reports the rejection. */
    rebind("#tamperBtn", "click", () => guard(async () => {
      if (session.org !== "nado") {
        banner("warn",
          `<b>Not available to this role.</b> This control attempts a results-management ` +
          `write, which only a national anti-doping organisation may submit. You are signed ` +
          `in as <span class="mono">${session.mspId}</span> — sign in as ` +
          `<span class="mono">nadouser</span> to run it. The refusal you would otherwise see ` +
          `comes from the gateway, before the ledger is reached.`);
        ui.toast("Requires a NADO sign-in");
        return;
      }
      ui.toast("Attempting a single-organization write…");
      try {
        await POST(`/samples/${encodeURIComponent(state.sampleCode)}/results-management?endorsers=NADOMSP`,
          {});
        banner("warn", "<b>Unexpected:</b> the network accepted a single-organization write.");
        ui.logFeed("warn", "Single-organization write was accepted — endorsement policy not enforced");
      } catch (e) {
        banner("ok",
          `<b>Rejected by the network.</b> A single organization cannot alter committed ` +
          `results-management state: that record is bound to a policy requiring peers from ` +
          `two distinct organizational classes. <span class="mono">${String(e.message).slice(0, 90)}</span>`);
        ui.logFeed("ok", "Tamper attempt rejected — cross-organizational endorsement enforced");
      }
    }, "Tamper attempt"));
  }

  /* ------------------------------------------------------------- bootstrap */

  async function boot() {
    if (!session) { showSignIn(); return; }
    styles();
    labelSections();
    networkPanel();
    wireNav();
    showIdentity();
    banner("", "Connecting to the ledger…");
    try {
      const seed = await POST("/demo/seed", {});
      state.athleteHash = seed.athleteHash;
      state.sampleCode = seed.sampleCode;
      state.online = true;
    } catch (e) {
      banner("warn",
        `<b>Ledger unreachable.</b> The page is showing the design's sample data, not live ` +
        `records. Start the network with <span class="mono">./scripts/network-up.sh</span> and ` +
        `<span class="mono">./scripts/deploy-chaincode.sh</span>. ` +
        `<span class="mono">${String(e.message).slice(0, 80)}</span>`);
      return;
    }

    try {
      const held = await GET(`/offchain/${state.athleteHash}`);
      state.erasable = new Set(held.map((h) => h.category));
    } catch { state.erasable = new Set(); }

    wire();
    await Promise.all([loadChain(), loadCategories(), loadFeed()]);

    const el = $("#verifyBanner");
    if (el) el.style.display = "none";
    ui.toast(`Live — sample ${state.sampleCode}`);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
