import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const cfg = window.LEAVE_PLANNER_CONFIG || {};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TYPE_LABEL = { annual: "Annual", sick: "Sick", personal: "Personal", unpaid: "Unpaid" };

// ---------------------------------------------------------------- dates

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayIso = () => iso(new Date());
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

function fmtRange(start, end) {
  const opts = { day: "numeric", month: "short" };
  const s = parse(start), e = parse(end);
  const year = e.getFullYear();
  if (start === end) return `${s.toLocaleDateString(undefined, opts)} ${year}`;
  return `${s.toLocaleDateString(undefined, opts)} – ${e.toLocaleDateString(undefined, opts)} ${year}`;
}

function workingDays(start, end) {
  let n = 0;
  for (let d = parse(start); iso(d) <= end; d.setDate(d.getDate() + 1)) {
    if (!isWeekend(d) && !state.holidaySet.has(iso(d))) n++;
  }
  return n;
}

const fmtDays = (n) => `${Number(n)} day${Number(n) === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- state

const state = {
  session: null,
  me: null,
  profiles: [],
  byId: new Map(),
  requests: [],
  holidays: [],
  holidaySet: new Set(),
  year: new Date().getFullYear(),
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  signUp: false,
};

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

function setMsg(el, text, kind = "error") {
  el.textContent = text || "";
  el.className = `msg ${text ? kind : ""}`;
}

// ---------------------------------------------------------------- boot

if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  $("#setup").hidden = false;
  throw new Error("Supabase is not configured in config.js");
}

const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

sb.auth.onAuthStateChange((_event, session) => {
  // Supabase recommends not awaiting other client calls inside this callback.
  setTimeout(() => onSession(session), 0);
});

async function onSession(session) {
  const changedUser = session?.user?.id !== state.session?.user?.id;
  state.session = session;
  if (!session) {
    state.me = null;
    $("#main").hidden = true;
    $("#who").hidden = true;
    $("#auth").hidden = false;
    return;
  }
  if (!changedUser && state.me) return;
  $("#auth").hidden = true;
  await loadAll();
}

async function loadAll() {
  const [profiles, requests, holidays] = await Promise.all([
    sb.from("profiles").select("*").order("full_name"),
    sb.from("leave_requests").select("*").order("start_date", { ascending: false }),
    sb.from("holidays").select("*").order("holiday_date"),
  ]);
  const err = profiles.error || requests.error || holidays.error;
  if (err) {
    toast(`Could not load data: ${err.message}`);
    return;
  }
  state.profiles = profiles.data;
  state.byId = new Map(profiles.data.map((p) => [p.id, p]));
  state.requests = requests.data;
  state.holidays = holidays.data;
  state.holidaySet = new Set(holidays.data.map((h) => h.holiday_date));
  state.me = state.byId.get(state.session.user.id);
  if (!state.me) {
    toast("Your profile is missing. Has supabase/schema.sql been run?");
    return;
  }
  render();
}

// ---------------------------------------------------------------- auth UI

function setAuthMode(signUp) {
  state.signUp = signUp;
  $("#auth-title").textContent = signUp ? "Create account" : "Sign in";
  $("#auth-submit").textContent = signUp ? "Create account" : "Sign in";
  $("#name-field").hidden = !signUp;
  $("#auth-switch-text").textContent = signUp ? "Already have an account?" : "New here?";
  $("#auth-switch").textContent = signUp ? "Sign in" : "Create an account";
  $("#auth-form [name=password]").autocomplete = signUp ? "new-password" : "current-password";
  setMsg($("#auth-msg"), "");
}

$("#auth-switch").addEventListener("click", () => setAuthMode(!state.signUp));

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const email = f.get("email").trim();
  const password = f.get("password");
  const btn = $("#auth-submit");
  const msg = $("#auth-msg");
  btn.disabled = true;
  setMsg(msg, "");
  try {
    if (state.signUp) {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: f.get("full_name").trim() },
          emailRedirectTo: location.origin + location.pathname,
        },
      });
      if (error) throw error;
      if (!data.session) setMsg(msg, "Check your inbox to confirm your email, then sign in.", "ok");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    setMsg(msg, err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#sign-out").addEventListener("click", () => sb.auth.signOut());

// ---------------------------------------------------------------- tabs

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  })
);

// ---------------------------------------------------------------- render

const isManager = () => state.me?.role === "manager";
const firstName = (p) => (p?.full_name || p?.email || "Someone").split(" ")[0];
const mine = () => state.requests.filter((r) => r.user_id === state.me.id);
const yearOf = (r) => Number(r.start_date.slice(0, 4));

function annualUsage(userId, year) {
  let used = 0, pending = 0;
  for (const r of state.requests) {
    if (r.user_id !== userId || r.leave_type !== "annual" || yearOf(r) !== year) continue;
    if (r.status === "approved") used += Number(r.days);
    if (r.status === "pending") pending += Number(r.days);
  }
  return { used, pending };
}

function render() {
  $("#main").hidden = false;
  $("#who").hidden = false;
  $("#who-name").textContent = state.me.full_name || state.me.email;
  $("#who-role").textContent = state.me.role;
  $$(".manager-only").forEach((el) => (el.hidden = !isManager()));
  if (!isManager() && !$('.tab.active:not(.manager-only)')) $('.tab[data-tab="mine"]').click();

  renderStats();
  renderYearFilter();
  renderMyList();
  renderCalendar();
  updatePreview();
  if (isManager()) {
    renderApprovals();
    renderTeam();
    renderHolidays();
  }
}

function renderStats() {
  const year = new Date().getFullYear();
  const allowance = Number(state.me.annual_allowance);
  const { used, pending } = annualUsage(state.me.id, year);
  const remaining = allowance - used - pending;
  const sick = mine()
    .filter((r) => r.leave_type === "sick" && r.status === "approved" && yearOf(r) === year)
    .reduce((s, r) => s + Number(r.days), 0);
  const pct = (n) => (allowance > 0 ? Math.min(100, (n / allowance) * 100) : 0);

  $("#stats").innerHTML = `
    <div class="stat">
      <div class="label">Annual leave left (${year})</div>
      <div class="value">${remaining} <small>of ${allowance}</small></div>
      <div class="bar"><i class="used" style="width:${pct(used)}%"></i><i class="held" style="width:${pct(pending)}%"></i></div>
    </div>
    <div class="stat"><div class="label">Taken</div><div class="value">${used} <small>days</small></div></div>
    <div class="stat"><div class="label">Awaiting approval</div><div class="value">${pending} <small>days</small></div></div>
    <div class="stat"><div class="label">Sick days</div><div class="value">${sick} <small>days</small></div></div>`;
}

function renderYearFilter() {
  const years = new Set([new Date().getFullYear(), ...mine().map(yearOf)]);
  const sel = $("#year-filter");
  sel.innerHTML = [...years].sort((a, b) => b - a)
    .map((y) => `<option value="${y}" ${y === state.year ? "selected" : ""}>${y}</option>`).join("");
}

$("#year-filter").addEventListener("change", (e) => {
  state.year = Number(e.target.value);
  renderMyList();
});

function requestItem(r, { showName = false, actions = "", extra = "" } = {}) {
  const who = showName ? `${esc(state.byId.get(r.user_id)?.full_name || "Unknown")} · ` : "";
  const half = r.half_day ? " (half day)" : "";
  const note = r.manager_note ? `<div class="sub">Manager note: ${esc(r.manager_note)}</div>` : "";
  const reason = r.reason ? `<div class="sub">“${esc(r.reason)}”</div>` : "";
  return `
    <div class="item">
      <div class="main">
        <div class="title">${who}${TYPE_LABEL[r.leave_type]} leave<span class="badge ${r.status}">${r.status}</span></div>
        <div class="sub">${fmtRange(r.start_date, r.end_date)} · ${fmtDays(r.days)}${half}</div>
        ${reason}${note}${extra}
      </div>
      ${actions ? `<div class="actions">${actions}</div>` : ""}
    </div>`;
}

function renderMyList() {
  const list = mine().filter((r) => yearOf(r) === state.year);
  const today = todayIso();
  $("#my-list").innerHTML = list.length
    ? list.map((r) => {
        const canCancel = r.status === "pending" || (r.status === "approved" && r.start_date >= today);
        return requestItem(r, {
          actions: canCancel ? `<button class="btn ghost small" data-cancel="${r.id}">Cancel</button>` : "",
        });
      }).join("")
    : `<p class="empty">No leave requested in ${state.year}.</p>`;
}

$("#my-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.cancel;
  if (!id || !confirm("Cancel this leave request?")) return;
  const { error } = await sb.from("leave_requests").update({ status: "cancelled" }).eq("id", id);
  if (error) return toast(error.message);
  toast("Request cancelled");
  await loadAll();
});

// ---------------------------------------------------------------- request form

const form = $("#request-form");

function updatePreview() {
  const f = new FormData(form);
  const start = f.get("start_date"), end = f.get("end_date");
  const out = $("#days-preview");
  if (!start || !end) return (out.textContent = "");
  if (end < start) return (out.textContent = "End date is before start date.");
  if (f.get("half_day") && start !== end) return (out.textContent = "A half day must be a single date.");
  const days = workingDays(start, end) * (f.get("half_day") ? 0.5 : 1);
  let text = `${fmtDays(days)} of leave (weekends and public holidays excluded).`;
  if (f.get("leave_type") === "annual") {
    const { used, pending } = annualUsage(state.me.id, Number(start.slice(0, 4)));
    const left = Number(state.me.annual_allowance) - used - pending;
    if (days > left) text += ` This is more than the ${left} annual days you have left.`;
  }
  out.textContent = text;
}

form.addEventListener("input", (e) => {
  if (e.target.name === "start_date" && !form.end_date.value) form.end_date.value = e.target.value;
  if (e.target.name === "half_day" && e.target.checked && form.start_date.value) form.end_date.value = form.start_date.value;
  updatePreview();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const msg = $("#request-msg");
  const row = {
    leave_type: f.get("leave_type"),
    start_date: f.get("start_date"),
    end_date: f.get("end_date"),
    half_day: !!f.get("half_day"),
    reason: f.get("reason").trim() || null,
  };
  if (row.end_date < row.start_date) return setMsg(msg, "End date is before start date.");
  if (row.half_day && row.start_date !== row.end_date) return setMsg(msg, "A half day must be a single date.");

  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  const { error } = await sb.from("leave_requests").insert(row);
  btn.disabled = false;
  if (error) return setMsg(msg, error.message);
  form.reset();
  setMsg(msg, isManager() ? "Submitted. Approve it from the Approvals tab." : "Submitted for approval.", "ok");
  await loadAll();
});

// ---------------------------------------------------------------- calendar

function renderCalendar() {
  const first = state.month;
  $("#month-label").textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // back to Monday
  const live = state.requests.filter((r) => r.status === "approved" || r.status === "pending");
  const holidayName = new Map(state.holidays.map((h) => [h.holiday_date, h.name]));
  const today = todayIso();

  let html = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (i === 35 && d.getMonth() !== first.getMonth()) break; // drop an all-next-month last row
    const key = iso(d);
    const classes = ["day"];
    if (d.getMonth() !== first.getMonth()) classes.push("out");
    if (isWeekend(d)) classes.push("weekend");
    if (key === today) classes.push("today");

    let chips = "";
    if (holidayName.has(key)) chips += `<div class="chip holiday" title="${esc(holidayName.get(key))}">${esc(holidayName.get(key))}</div>`;
    if (!isWeekend(d) && !holidayName.has(key)) {
      for (const r of live) {
        if (r.start_date <= key && r.end_date >= key) {
          const p = state.byId.get(r.user_id);
          const label = `${firstName(p)}${r.half_day ? " ½" : ""}`;
          chips += `<div class="chip ${r.status}" title="${esc(p?.full_name)} – ${TYPE_LABEL[r.leave_type]} (${r.status})">${esc(label)}</div>`;
        }
      }
    }
    html += `<div class="${classes.join(" ")}"><span class="num">${d.getDate()}</span>${chips}</div>`;
  }
  $("#calendar").innerHTML = html;
}

function shiftMonth(delta) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1);
  renderCalendar();
}
$("#prev-month").addEventListener("click", () => shiftMonth(-1));
$("#next-month").addEventListener("click", () => shiftMonth(1));

// ---------------------------------------------------------------- approvals

function renderApprovals() {
  const pending = state.requests.filter((r) => r.status === "pending").sort((a, b) => a.start_date.localeCompare(b.start_date));
  $("#pending-count").textContent = pending.length || "";

  $("#approval-list").innerHTML = pending.length
    ? pending.map((r) => {
        const p = state.byId.get(r.user_id);
        const others = state.requests.filter((o) =>
          o.user_id !== r.user_id && o.status === "approved" && o.start_date <= r.end_date && o.end_date >= r.start_date);
        const names = [...new Set(others.map((o) => firstName(state.byId.get(o.user_id))))];
        let context = names.length ? `Also off: ${esc(names.join(", "))}` : "Nobody else is off then";
        if (r.leave_type === "annual") {
          const { used } = annualUsage(r.user_id, yearOf(r));
          context += ` · ${Number(p?.annual_allowance ?? 0) - used} annual days left before this`;
        }
        return requestItem(r, {
          showName: true,
          extra: `<div class="sub">${context}</div>`,
          actions: `
            <button class="btn primary small" data-review="approved" data-id="${r.id}">Approve</button>
            <button class="btn danger small" data-review="rejected" data-id="${r.id}">Reject</button>`,
        });
      }).join("")
    : `<p class="empty">All caught up.</p>`;

  const reviewed = state.requests
    .filter((r) => (r.status === "approved" || r.status === "rejected") && r.reviewed_at)
    .sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at))
    .slice(0, 15);
  $("#reviewed-list").innerHTML = reviewed.length
    ? reviewed.map((r) => requestItem(r, { showName: true })).join("")
    : `<p class="empty">Nothing reviewed yet.</p>`;
}

$("#approval-list").addEventListener("click", async (e) => {
  const status = e.target.dataset.review;
  if (!status) return;
  let note = null;
  if (status === "rejected") {
    note = prompt("Reason for rejecting (optional):");
    if (note === null) return;
  }
  e.target.disabled = true;
  const { error } = await sb.from("leave_requests")
    .update({ status, manager_note: note?.trim() || null })
    .eq("id", e.target.dataset.id);
  if (error) {
    e.target.disabled = false;
    return toast(error.message);
  }
  toast(status === "approved" ? "Approved" : "Rejected");
  await loadAll();
});

// ---------------------------------------------------------------- team admin

function renderTeam() {
  const year = new Date().getFullYear();
  $("#team-table tbody").innerHTML = state.profiles.map((p) => {
    const { used } = annualUsage(p.id, year);
    const self = p.id === state.me.id;
    return `
      <tr data-id="${p.id}">
        <td><div>${esc(p.full_name)}</div><div class="muted" style="font-size:.8rem">${esc(p.email)}</div></td>
        <td><select data-field="role" ${self ? 'disabled title="You cannot change your own role"' : ""}>
          <option value="employee" ${p.role === "employee" ? "selected" : ""}>Employee</option>
          <option value="manager" ${p.role === "manager" ? "selected" : ""}>Manager</option>
        </select></td>
        <td><input type="number" min="0" max="365" step="0.5" value="${Number(p.annual_allowance)}" data-field="annual_allowance"></td>
        <td class="num">${used}</td>
      </tr>`;
  }).join("");
}

$("#team-table").addEventListener("change", async (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const id = e.target.closest("tr").dataset.id;
  const value = field === "annual_allowance" ? Number(e.target.value) : e.target.value;
  const { error } = await sb.from("profiles").update({ [field]: value }).eq("id", id);
  if (error) return toast(error.message);
  toast("Saved");
  await loadAll();
});

// ---------------------------------------------------------------- holidays

function renderHolidays() {
  const fromYear = `${new Date().getFullYear()}-01-01`;
  const list = state.holidays.filter((h) => h.holiday_date >= fromYear);
  $("#holiday-list").innerHTML = list.length
    ? list.map((h) => `
        <div class="item">
          <div class="main"><div class="title">${esc(h.name)}</div><div class="sub">${fmtRange(h.holiday_date, h.holiday_date)}</div></div>
          <div class="actions"><button class="btn ghost small" data-del-holiday="${h.id}">Remove</button></div>
        </div>`).join("")
    : `<p class="empty">No public holidays added for this year.</p>`;
}

$("#holiday-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const { error } = await sb.from("holidays").insert({ holiday_date: f.get("holiday_date"), name: f.get("name").trim() });
  if (error) return setMsg($("#holiday-msg"), error.message);
  e.target.reset();
  setMsg($("#holiday-msg"), "");
  await loadAll();
});

$("#holiday-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.delHoliday;
  if (!id || !confirm("Remove this holiday?")) return;
  const { error } = await sb.from("holidays").delete().eq("id", id);
  if (error) return toast(error.message);
  await loadAll();
});
