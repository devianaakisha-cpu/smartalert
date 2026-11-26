// ---- Config ----
const DEMO_MODE = false;   // live Firebase data
const firebaseConfig = {
  apiKey: "AIzaSyBQLBTSLAm02EPqMefbtCIqQBbE_0H5uEg",
  authDomain: "smartalert-d2fd6.firebaseapp.com",
  databaseURL: "https://smartalert-d2fd6-default-rtdb.firebaseio.com",
  projectId: "smartalert-d2fd6"
};

const alerts = {};            // id -> {id, room, status, keys:Set, time}
// Firebase's clock is the true time. serverOffset = true time minus this PC's clock (ms),
// so a wrong PC clock or time zone no longer breaks alert times or the timers.
let serverOffset = 0;
const nowMs = () => Date.now() + serverOffset;               // true current time
const shownTime = (t) => new Date(+t - serverOffset);        // shown the same way as the PC's own clock
let liveReady = false;       // true once the alerts that already existed have loaded
const RESOLVED = ["acknowledged", "false_alarm"];
let logEmpty = true;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const label = (s) => ({triggered:"TRIGGERED", escalated:"ESCALATED", acknowledged:"ACKNOWLEDGED", false_alarm:"FALSE ALARM", tamper:"TAMPER"}[s] || s.toUpperCase());

function addLog(text, status) {
  const log = $("log");
  if (logEmpty) { log.innerHTML = ""; logEmpty = false; }
  const row = document.createElement("div");
  row.className = status || "";
  row.textContent = new Date().toLocaleTimeString() + "  ·  " + text;
  log.prepend(row);
}

// ---- Shared render logic (demo + live) ----
function handleAlertEvent(key, data) {
  if (!data || !data.room) return;
  const id = data.id || key;
  const status = data.status || "triggered";
  let a = alerts[id];
  const isNew = !a;
  if (isNew) a = alerts[id] = { id, keys: new Set(), time: new Date(typeof data.time === "number" ? data.time : nowMs()) };
  a.keys.add(key);
  a.room = data.room;
  a.pattern = data.pattern || a.pattern || "single";
  a.by = data.by || a.by;
  a.incidentType = data.incidentType || a.incidentType;
  a.note = data.note !== undefined ? data.note : a.note;
  a.claimedBy = data.claimedBy || a.claimedBy;
  a.respondedAt = data.respondedAt || a.respondedAt;
  const changed = isNew || a.status !== status;
  a.status = status;
  // Stop ringing once the alert is acknowledged, marked false alarm, or someone is responding
  if (RESOLVED.includes(status) || a.claimedBy) { ringing.delete(id); updateRinging(); }
  if (changed) addLog(a.room + " – " + patternName(a) + " – " + label(status), cardClass(a));
  if (changed && !RESOLVED.includes(status) && liveReady) notify(a);   // no dependence on the PC clock
  render();
}

function render() {
  const list = Object.values(alerts);
  const active = list.filter((a) => !RESOLVED.includes(a.status));
  const box = $("active");
  box.innerHTML = "";
  if (!active.length) box.innerHTML = '<div class="empty">No active alerts</div>';
  active.sort((a, b) => b.time - a.time).forEach((a) => {
    const card = document.createElement("div");
    card.className = "card " + cardClass(a);
    card.innerHTML =
      '<div class="top"><span class="room">' + esc(a.room) + '</span><span class="tag">' + patternName(a) + ' · ' + label(a.status) + '</span></div>' +
      '<div class="meta">Alert ' + esc(a.id) + ' · ' + shownTime(a.time).toLocaleTimeString() + '</div>' +
      '<div class="hint" data-id="' + esc(a.id) + '"></div>' +
      cardExtra(a) +
      '<div class="actions">' +
      '<button class="ack' + sg(a, 'acknowledged') + '" onclick="respond(\'' + esc(a.id) + '\',\'acknowledged\')">Acknowledge</button>' +
      '<button class="fa' + sg(a, 'false_alarm') + '" onclick="respond(\'' + esc(a.id) + '\',\'false_alarm\')">False alarm</button>' +
      '<button class="esc' + sg(a, 'escalated') + '" onclick="respond(\'' + esc(a.id) + '\',\'escalated\')">Escalate</button>' +
      '</div>';
    box.appendChild(card);
  });
  updateHints();
  $("sActive").textContent = active.length;
  $("sEsc").textContent = list.filter((a) => a.status === "escalated").length;
  $("sRes").textContent = list.filter((a) => RESOLVED.includes(a.status)).length;
  $("sTotal").textContent = list.length;
  $("sAvg").textContent = avgResponse(list);
  renderRooms();
  renderAnalytics(list);
  document.title = (active.length ? "(" + active.length + ") " : "") + "SmartAlert";
}

// ---- How the alert was raised decides what the responder should do ----
const ESCALATE_S = 120;   // same as ESCALATE_AFTER_MS on the ESP32
const PATTERNS = {
  single: { name: "Single press", action: "false_alarm",  text: "Single press: possibly accidental. Verify the room, mark FALSE ALARM if safe." },
  double: { name: "Double press", action: "acknowledged", text: "Double press: deliberate call for help. ACKNOWLEDGE and respond." },
  long:   { name: "Long press",   action: "escalated",    text: "Long press: emergency. ESCALATE immediately." },
  tamper: { name: "Tamper",       action: "escalated",    text: "Tamper: the unit was opened or moved. ESCALATE and check the device." }
};
const pat = (a) => PATTERNS[a.pattern] || PATTERNS.single;
const patternName = (a) => pat(a).name;
function cardClass(a) {
  if (RESOLVED.includes(a.status)) return "s-" + a.status;
  if (a.status === "escalated") return "s-escalated";
  return "p-" + (PATTERNS[a.pattern] ? a.pattern : "single");
}
function sg(a, action) {   // highlight the suggested button
  const suggested = a.status === "escalated" ? "acknowledged" : pat(a).action;
  return suggested === action ? " sug" : "";
}
function updateHints() {
  document.querySelectorAll(".hint").forEach((el) => {
    const a = alerts[el.dataset.id];
    if (!a) return;
    const age = Math.floor((nowMs() - a.time) / 1000);
    let text, cls = "";
    if (a.status === "escalated") {
      text = "ESCALATED: immediate action needed. Acknowledge once someone is on site.";
      cls = "danger";
    } else {
      text = pat(a).text;
      if (age >= 30) { text += " No response for " + age + "s."; cls = "warn"; }
      if (age >= 90) { text += " Auto-escalates in " + Math.max(ESCALATE_S - age, 0) + "s."; cls = "danger"; }
    }
    el.textContent = text;
    el.className = "hint " + cls;
  });
}
setInterval(updateHints, 1000);

// ---- Extra features: sound, notifications, rooms, response time, CSV ----
const KNOWN_ROOMS = ["LAB ICT 1", "Room 204", "Library", "Gym"];
let responder = "Demo responder";
let soundOn = true, audioCtx;

// Alarm loop: keeps beeping while any live alert is still unanswered.
const ringing = new Set();   // ids of alerts that are still ringing
let ringTimer = null;
function anyUrgent() {
  return [...ringing].some((id) => {
    const a = alerts[id];
    return a && (a.status === "escalated" || a.pattern === "long" || a.pattern === "tamper");
  });
}
function updateRinging() {
  if (ringing.size && soundOn) {
    if (!ringTimer) {
      beep(anyUrgent());
      ringTimer = setInterval(() => beep(anyUrgent()), 2000);
    }
  } else if (ringTimer) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
}

// Browsers keep audio locked until the person clicks/taps/presses a key on the page.
function getCtx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
["click", "touchstart", "keydown"].forEach((ev) =>
  document.addEventListener(ev, () => { try { getCtx(); } catch (e) {} }));

function beep(urgent) {
  if (!soundOn) return;
  try {
    getCtx();
    const n = urgent ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.frequency.value = urgent ? 980 : 660;
      g.gain.value = 0.15;
      o.start(audioCtx.currentTime + i * 0.3);
      o.stop(audioCtx.currentTime + i * 0.3 + 0.18);
    }
  } catch (e) { console.warn("Beep failed:", e); }
}
function notify(a) {
  if (!a.claimedBy) ringing.add(a.id);   // keep ringing until someone responds
  updateRinging();
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("SmartAlert: " + a.room, { body: pat(a).text }); } catch (e) {}
  }
}
function toggleSound() {
  soundOn = !soundOn;
  $("soundBtn").textContent = soundOn ? "🔔 Sound on" : "🔕 Sound off";
  updateRinging();
  if (soundOn && !ringing.size) beep(false);
}
function askNotify() {
  if (!("Notification" in window)) return;
  Notification.requestPermission().then((p) => {
    $("notifBtn").textContent = p === "granted" ? "✅ Notifications on" : "Notifications blocked";
  });
}
function avgResponse(list) {
  const t = list.filter((a) => a.respondedAt).map((a) => (a.respondedAt - a.time) / 1000).filter((x) => x >= 0);
  if (!t.length) return "–";
  const m = Math.round(t.reduce((x, y) => x + y, 0) / t.length);
  return m < 60 ? m + "s" : Math.floor(m / 60) + "m " + (m % 60) + "s";
}
function renderRooms() {
  const latest = {};
  Object.values(alerts).forEach((a) => { if (!latest[a.room] || a.time > latest[a.room].time) latest[a.room] = a; });
  const names = Array.from(new Set(KNOWN_ROOMS.concat(Object.keys(latest))));
  $("rooms").innerHTML = names.map((r) => {
    const a = latest[r];
    const live = a && !RESOLVED.includes(a.status);
    return '<div class="room-tile ' + (live ? cardClass(a) : "s-acknowledged") + '"><b>' + esc(r) + '</b><br>' +
           (live ? esc(patternName(a)) + " · " + label(a.status) : "All clear") + '<br><small>' + deviceLine(r) + '</small></div>';
  }).join("");
}
function exportCsv() {
  const rows = [["id", "room", "press", "status", "time", "responder", "response_seconds", "incident_type", "note"]];
  Object.values(alerts).forEach((a) => rows.push([a.id, a.room, patternName(a), a.status, a.time.toISOString(),
    a.by || "", a.respondedAt ? Math.round((a.respondedAt - a.time) / 1000) : "", a.incidentType || "", a.note || ""]));
  const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = "smartalert_history.csv";
  link.click();
}
// ---- New: incident type, notes, claim, analytics, device monitor ----
const INCIDENT_TYPES = ["Unclassified", "Medical", "Fire", "Security threat", "Fight", "Accident", "Drill / test"];
function cardExtra(a) {
  const id = esc(a.id);
  const opts = INCIDENT_TYPES.map((t) => `<option${(a.incidentType || "Unclassified") === t ? " selected" : ""}>${t}</option>`).join("");
  return `<div class="extra">
    <select data-id="${id}" onchange="setField(this.dataset.id,'incidentType',this.value)">${opts}</select>
    <input data-id="${id}" placeholder="Add note…" value="${esc(a.note || "")}" onchange="setField(this.dataset.id,'note',this.value)">
    <button class="claim" data-id="${id}" onclick="claim(this.dataset.id)">${a.claimedBy ? "Responding: " + esc(a.claimedBy) : "I’m responding"}</button>
  </div>`;
}
function setField(id, field, value) {
  const a = alerts[id];
  if (!a) return;
  a[field] = value;
  if (!DEMO_MODE) a.keys.forEach((k) => firebase.database().ref("alerts/" + k).update({ [field]: value }));
  const what = field === "note" ? "note added" : field === "claimedBy" ? value + " is responding" : "type: " + value;
  addLog(a.room + " – " + what, cardClass(a));
  render();
}
function claim(id) { setField(id, "claimedBy", responder); }

function renderAnalytics(list) {
  const box = $("analytics");
  if (!list.length) { box.innerHTML = '<div class="empty">No data yet</div>'; return; }
  const resolved = list.filter((a) => RESOLVED.includes(a.status)).length;
  const fa = list.filter((a) => a.status === "false_alarm").length;
  const tally = (fn) => list.reduce((m, a) => { const k = fn(a); m[k] = (m[k] || 0) + 1; return m; }, {});
  const bars = (title, counts) => '<div class="bt">' + title + '</div>' + Object.entries(counts)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => '<div class="bar"><span>' + esc(k) + '</span><i style="width:' + Math.max(4, Math.round(v / list.length * 60)) + '%"></i><b>' + v + '</b></div>').join("");
  box.innerHTML = '<div class="kpi"><b>' + (resolved ? Math.round(fa / resolved * 100) + "%" : "–") +
    '</b> false-alarm rate (' + fa + ' of ' + resolved + ' resolved)</div>' +
    bars("By room", tally((a) => a.room)) + bars("By press type", tally(patternName)) +
    bars("By incident type", tally((a) => a.incidentType || "Unclassified"));
}

let devices = {};
const OFFLINE_MS = 3 * 60 * 1000;   // no heartbeat for 3 minutes = offline
const prevOnline = {};
const roomKey = (r) => r.replace(/ /g, "_");
function deviceLine(room) {
  const d = devices[roomKey(room)];
  if (!d || !d.lastSeen) return "No device data";
  return nowMs() - d.lastSeen < OFFLINE_MS
    ? '<span class="on">● Online</span>'
    : '<span class="off">○ Offline since ' + shownTime(d.lastSeen).toLocaleTimeString() + '</span>';
}
function updateDevices() {
  let online = 0, total = 0;
  Object.keys(devices).forEach((k) => {
    const d = devices[k];
    const on = nowMs() - d.lastSeen < OFFLINE_MS;
    total++;
    if (on) online++;
    if (prevOnline[k] !== undefined && prevOnline[k] !== on) {
      addLog((d.room || k) + " device " + (on ? "back ONLINE" : "went OFFLINE"), on ? "s-acknowledged" : "s-escalated");
      if (!on) beep(true);
    }
    prevOnline[k] = on;
  });
  $("sDev").textContent = total ? online + "/" + total : "–";
  renderRooms();
}
setInterval(updateDevices, 15000);
renderRooms();

// ---- Administrator sign-in ----
const IDLE_MS = 15 * 60 * 1000;   // auto sign-out after 15 minutes without activity
const DEMO_LOGIN = { email: "admin@smartalert.com", password: "demo1234" };
let idleTimer, liveStarted = false, pendingMsg = "";

function showApp(email) {
  $("login").hidden = true;
  $("app").hidden = false;
  $("who").textContent = email;
  resetIdle();
}
function showLogin(msg) {
  $("app").hidden = true;
  $("login").hidden = false;
  $("loginErr").textContent = msg || "";
  $("pw").value = "";
  clearTimeout(idleTimer);
}
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => signOutNow("Signed out after 15 minutes of inactivity."), IDLE_MS);
}
["click", "keydown", "touchstart"].forEach((ev) =>
  document.addEventListener(ev, () => { if (!$("app").hidden) resetIdle(); }, { passive: true }));

function friendlyAuthError(err) {
  const c = err.code || "";
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c)) return "Wrong email or password.";
  if (c === "auth/too-many-requests") return "Too many attempts. Try again later.";
  if (c === "auth/network-request-failed") return "No internet connection.";
  return err.message;
}
function doLogin(e) {
  e.preventDefault();
  const email = $("em").value.trim(), pw = $("pw").value;
  $("loginErr").textContent = "";
  if (DEMO_MODE) {
    if (email.toLowerCase() === DEMO_LOGIN.email && pw === DEMO_LOGIN.password) { responder = email; showApp(email); }
    else $("loginErr").textContent = "Wrong email or password.";
    return;
  }
  $("goBtn").disabled = true;
  const P = firebase.auth.Auth.Persistence;
  firebase.auth().setPersistence($("remember").checked ? P.LOCAL : P.SESSION)
    .then(() => firebase.auth().signInWithEmailAndPassword(email, pw))
    .catch((err) => { $("loginErr").textContent = friendlyAuthError(err); })
    .finally(() => { $("goBtn").disabled = false; });
}
function resetPassword() {
  const email = $("em").value.trim();
  if (!email) { $("loginErr").textContent = "Enter your email first."; return; }
  if (DEMO_MODE) { $("loginErr").textContent = "Password reset is not available in demo mode."; return; }
  firebase.auth().sendPasswordResetEmail(email)
    .then(() => { $("loginErr").textContent = "Reset link sent. Check your email."; })
    .catch((err) => { $("loginErr").textContent = friendlyAuthError(err); });
}
function signOutNow(msg) {
  if (DEMO_MODE) { showLogin(msg); return; }
  pendingMsg = msg || "";
  firebase.auth().signOut();
}

// ---- Demo trigger ----
function simulateAlert() {
  const id = String(Date.now() % 1000000);
  const rooms = ["LAB ICT 1", "Room 204", "Library", "Gym"];
  const pattern = ["single", "double", "long", "tamper"][Math.floor(Math.random() * 4)];
  handleAlertEvent("demo_" + id, { id, pattern, room: rooms[Math.floor(Math.random() * rooms.length)], status: pattern === "long" ? "escalated" : "triggered" });
}

// ---- Responder buttons ----
function respond(id, status) {
  const a = alerts[id];
  if (!a) return;
  if (!DEMO_MODE) {
    a.keys.forEach((k) => firebase.database().ref("alerts/" + k).update({
      status, by: responder, respondedAt: firebase.database.ServerValue.TIMESTAMP
    }));
  }
  a.status = status;
  a.by = responder;
  a.respondedAt = nowMs();
  addLog(a.room + " – " + label(status) + " (by " + responder + ")", cardClass(a));
  render();
}

// ---- Firebase listener (live mode only) ----
if (DEMO_MODE) {
  $("demoBanner").hidden = false;
  $("simBtn").hidden = false;
  $("demoHint").hidden = false;
  const t0 = Date.now();
  devices = { LAB_ICT_1: { room: "LAB ICT 1", lastSeen: t0 }, Room_204: { room: "Room 204", lastSeen: t0 },
              Library: { room: "Library", lastSeen: t0 - 10 * 60000 }, Gym: { room: "Gym", lastSeen: t0 } };
  setInterval(() => { ["LAB_ICT_1", "Room_204", "Gym"].forEach((k) => { devices[k].lastSeen = Date.now(); }); }, 20000);
  updateDevices();
  $("status").textContent = "Demo";
  $("status").className = "pill";
} else {
  firebase.initializeApp(firebaseConfig);

  function startLive() {
    if (liveStarted) return;
    liveStarted = true;
    responder = firebase.auth().currentUser.email;
    const db = firebase.database();
    const denied = () => { $("status").textContent = "No access"; $("status").className = "pill bad"; };

    // Connection status listener
    db.ref(".info/connected").on("value", (snap) => {
      const ok = snap.val() === true;
      $("status").textContent = ok ? "Live" : "Offline";
      $("status").className = "pill " + (ok ? "ok" : "bad");
    });

    // Learn how far this PC's clock is from the true (Firebase) time
    db.ref(".info/serverTimeOffset").on("value", (snap) => {
      serverOffset = snap.val() || 0;
      render(); updateDevices();
    });

    // Live alert feed
    db.ref("devices").on("value", (snap) => { devices = snap.val() || {}; updateDevices(); });

    const alertsRef = db.ref("alerts");
    alertsRef.on("child_added", (snap) => handleAlertEvent(snap.key, snap.val()), denied);
    alertsRef.on("child_changed", (snap) => handleAlertEvent(snap.key, snap.val()), denied);
    liveReady = false;
    alertsRef.once("value", () => { liveReady = true; });   // old alerts load first, silently
  }

  function stopLive() {
    if (!liveStarted) return;
    liveStarted = false;
    liveReady = false;
    ringing.clear(); updateRinging();
    firebase.database().ref("alerts").off();
    firebase.database().ref("devices").off();
    devices = {};
    firebase.database().ref(".info/connected").off();
    firebase.database().ref(".info/serverTimeOffset").off();
    Object.keys(alerts).forEach((k) => delete alerts[k]);
    $("log").innerHTML = "<div>No events yet</div>";
    logEmpty = true;
    render();
  }

  // Only administrators listed under /admins/<uid> may open the dashboard
  firebase.auth().onAuthStateChanged((user) => {
    if (!user) { stopLive(); showLogin(pendingMsg); pendingMsg = ""; return; }
    if (user.email === "esp32@smartalert.com") { pendingMsg = "This account is for the device only."; firebase.auth().signOut(); return; }
    // The database rules decide who is an administrator: if the read is denied, sign out
    firebase.database().ref("alerts").limitToFirst(1).once("value")
      .then(() => { showApp(user.email); startLive(); })
      .catch(() => { pendingMsg = "Access denied. This account is not an administrator."; firebase.auth().signOut(); });
  });
}
