"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { mode: "record", blob: null, blobName: "memo.webm", transcript: "", language: "", audio: null, recipe: null, recipes: [], sample: "" };

/* ---------- utils ---------- */
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
function showErr(msg) { const e = $("#err"); e.textContent = msg; e.hidden = !msg; }
async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let d = r.statusText;
    try { d = (await r.json()).detail || d; } catch { /* ignore */ }
    throw new Error(d);
  }
  return r.json();
}
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/* ---------- theme ---------- */
(function theme() {
  let t = "light";
  try { t = localStorage.getItem("hl-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch { /* ignore */ }
  document.documentElement.dataset.theme = t;
  $("#themeBtn").onclick = () => {
    t = t === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("hl-theme", t); } catch { /* ignore */ }
  };
})();

/* ---------- status pills ---------- */
async function loadStatus() {
  try {
    const s = await api("/api/status");
    state.sample = s.sample_transcript || "";
    const w = $("#pillWhisper"), o = $("#pillOllama");
    w.className = "pill " + (s.demo || s.whisper.installed ? "ok" : "bad");
    w.lastChild.textContent = s.demo ? "Whisper (demo)" : `Whisper · ${s.whisper.model}`;
    o.className = "pill " + (s.demo || s.ollama.model_ready ? "ok" : s.ollama.up ? "warn" : "bad");
    o.lastChild.textContent = s.demo ? "Gemma (demo)" : s.ollama.up ? s.ollama.model : "Ollama offline";
    o.title = s.ollama.up && !s.ollama.model_ready ? `Run: ollama pull ${s.ollama.model}` : "";
  } catch { /* server not reachable */ }
}

/* ---------- tabs ---------- */
$$(".tab").forEach(b => b.onclick = () => {
  state.mode = b.dataset.mode;
  $$(".tab").forEach(x => x.classList.toggle("active", x === b));
  ["record", "upload", "paste"].forEach(m => $("#pane-" + m).hidden = m !== state.mode);
  updateMake();
});
function updateMake() {
  const ok = state.mode === "paste" ? $("#pasteBox").value.trim().length > 14 : !!state.blob;
  $("#makeBtn").disabled = !ok;
}
$("#pasteBox").addEventListener("input", updateMake);
$("#sampleBtn").onclick = () => { $("#pasteBox").value = state.sample; updateMake(); };

/* ---------- upload ---------- */
const drop = $("#drop");
function setFile(f) {
  if (!f) return;
  state.blob = f; state.blobName = f.name;
  $("#dropTitle").textContent = "✓ " + f.name;
  updateMake();
}
$("#fileInput").onchange = e => setFile(e.target.files[0]);
["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => setFile(e.dataTransfer.files[0]));

/* ---------- recorder with live waveform ---------- */
const rec = { mr: null, chunks: [], ctx: null, an: null, raf: 0, t0: 0, tick: 0, stream: null };
const cv = $("#wave"), cx = cv.getContext("2d");
function drawIdle() {
  cx.clearRect(0, 0, cv.width, cv.height);
  const col = getComputedStyle(document.documentElement).getPropertyValue("--line");
  cx.fillStyle = col;
  for (let x = 6; x < cv.width; x += 12) cx.fillRect(x, cv.height / 2 - 2, 6, 4);
}
drawIdle();
function drawLive() {
  const data = new Uint8Array(rec.an.frequencyBinCount);
  rec.an.getByteFrequencyData(data);
  cx.clearRect(0, 0, cv.width, cv.height);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  cx.fillStyle = accent;
  const bars = 52, step = Math.floor(data.length / bars) || 1, w = cv.width / bars;
  for (let i = 0; i < bars; i++) {
    const v = data[i * step] / 255, h = Math.max(4, v * cv.height * 0.95);
    const x = i * w + 2, y = (cv.height - h) / 2;
    cx.beginPath(); cx.roundRect(x, y, w - 5, h, 4); cx.fill();
  }
  rec.raf = requestAnimationFrame(drawLive);
}
async function startRec() {
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showErr("I couldn't access the microphone. Allow mic permission, or use Upload instead."); return;
  }
  showErr("");
  rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
  rec.an = rec.ctx.createAnalyser(); rec.an.fftSize = 256;
  rec.ctx.createMediaStreamSource(rec.stream).connect(rec.an);
  rec.chunks = [];
  rec.mr = new MediaRecorder(rec.stream);
  rec.mr.ondataavailable = e => e.data.size && rec.chunks.push(e.data);
  rec.mr.onstop = () => {
    const type = rec.mr.mimeType || "audio/webm";
    state.blob = new Blob(rec.chunks, { type });
    state.blobName = "memo." + (type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm");
    const p = $("#recPlayback"); p.src = URL.createObjectURL(state.blob); p.hidden = false;
    updateMake();
  };
  rec.mr.start();
  rec.t0 = Date.now();
  rec.tick = setInterval(() => $("#recTime").textContent = fmt((Date.now() - rec.t0) / 1000), 250);
  $("#recBtn").classList.add("on");
  $("#recHint").textContent = "Listening… tap again to stop.";
  $("#recPlayback").hidden = true; state.blob = null; updateMake();
  drawLive();
}
function stopRec() {
  rec.mr?.stop(); rec.stream?.getTracks().forEach(t => t.stop());
  cancelAnimationFrame(rec.raf); clearInterval(rec.tick); rec.ctx?.close();
  $("#recBtn").classList.remove("on");
  $("#recHint").textContent = "Got it. Listen back, or tap to record again.";
  drawIdle();
}
$("#recBtn").onclick = () => (rec.mr && rec.mr.state === "recording") ? stopRec() : startRec();

/* ---------- pipeline ---------- */
function setStep(n) {
  $$("#pipeline li").forEach(li => {
    const s = +li.dataset.s;
    li.classList.toggle("done", s < n);
    li.classList.toggle("active", s === n);
  });
}

/* ---------- main flow ---------- */
$("#makeBtn").onclick = async () => {
  showErr(""); const btn = $("#makeBtn"); btn.disabled = true; btn.textContent = "Working…";
  $("#resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#resultActions").hidden = true;
  $("#preview").className = "empty"; $("#preview").innerHTML = '<div class="empty-art">👂</div><p>Listening carefully…</p>';
  try {
    state.audio = null; state.language = "";
    if (state.mode === "paste") {
      state.transcript = $("#pasteBox").value.trim();
      setStep(2);
    } else {
      setStep(1);
      const fd = new FormData(); fd.append("audio", state.blob, state.blobName);
      const t = await api("/api/transcribe", { method: "POST", body: fd });
      state.transcript = t.transcript; state.language = t.language; state.audio = t.audio;
      setStep(2);
    }
    $("#preview").innerHTML = '<div class="empty-art">🧑‍🍳</div><p>Writing it up in their style…</p>';
    const r = await api("/api/structure", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: state.transcript, storyteller: $("#storyteller").value || "Grandpa", output_language: $("#outLang").value })
    });
    setStep(3);
    state.recipe = r;
    renderPreview();
    $("#resultActions").hidden = false;
    setTimeout(() => $$("#pipeline li").forEach(li => li.classList.replace("active", "done")), 400);
  } catch (e) {
    showErr(e.message); setStep(0);
    $("#preview").className = "empty"; $("#preview").innerHTML = '<div class="empty-art">🍲</div><p>Your recipe will appear here.</p>';
  } finally {
    btn.textContent = "✨ Turn it into a recipe"; updateMake();
  }
};

/* ---------- recipe rendering ---------- */
function recipeHTML(r, opt = {}) {
  const chips = [
    r.serves && `<span class="chip">🍽️ Serves ${esc(r.serves)}</span>`,
    r.time && `<span class="chip">⏱️ ${esc(r.time)}</span>`,
    ...(r.tags || []).map(t => `<span class="chip">${esc(t)}</span>`),
    ...(r.allergens || []).map(a => `<span class="chip warn">⚠️ ${esc(a)}</span>`)
  ].filter(Boolean).join("");
  const ings = (r.ingredients || []).map(i =>
    `<li><label><input type="checkbox"><span>${i.amount ? `<b>${esc(i.amount)}</b> ` : ""}${esc(i.item)}</span></label></li>`).join("");
  const steps = (r.steps || []).map(s => `<li><span>${esc(s)}</span></li>`).join("");
  return `<article class="recipe">
    <h3 class="rtitle" ${opt.editable ? 'contenteditable="true" spellcheck="false" title="Click to edit"' : ""}>${esc(r.title)}</h3>
    ${opt.by ? `<small style="color:var(--muted)">As told by ${esc(opt.by)}</small>` : ""}
    <div class="meta">${chips}</div>
    ${opt.audio ? `<div class="voice"><small>🎙️ Hear it in ${esc(opt.by || "their")} voice</small><audio controls src="/audio/${encodeURIComponent(opt.audio)}"></audio></div>` : ""}
    ${r.story ? `<p class="story">${esc(r.story)}</p>` : ""}
    <h4>Ingredients</h4><ul class="ings">${ings}</ul>
    <h4>Method</h4><ol class="steps">${steps}</ol>
    ${(r.tips || []).length ? `<h4>Secrets & tips</h4><ul class="tips">${r.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    ${(r.unclear || []).length ? `<h4>Ask them next time</h4><ul class="ask">${r.unclear.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
  </article>`;
}
function renderPreview() {
  const p = $("#preview"); p.className = "";
  p.innerHTML = recipeHTML(state.recipe, { editable: true, by: $("#storyteller").value, audio: state.audio });
  $(".rtitle", p).addEventListener("input", e => state.recipe.title = e.target.textContent.trim());
}
$("#discardBtn").onclick = () => {
  state.recipe = null; setStep(0); $("#resultActions").hidden = true;
  $("#preview").className = "empty"; $("#preview").innerHTML = '<div class="empty-art">🍲</div><p>Your recipe will appear here.</p>';
};
$("#saveBtn").onclick = async () => {
  try {
    await api("/api/recipes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipe: state.recipe, storyteller: $("#storyteller").value, transcript: state.transcript, language: state.language, audio: state.audio })
    });
    toast("Saved to the family cookbook 📖");
    $("#discardBtn").click();
    await loadRecipes();
    $("#cookbook").scrollIntoView({ behavior: "smooth" });
  } catch (e) { showErr(e.message); }
};

/* ---------- cookbook ---------- */
const COVERS = ["#b4492f", "#3f6b5a", "#7a4f8a", "#2f5f8a", "#a8742a", "#8a3a4e", "#4a6a2f"];
const ICONS = ["🍲", "🥥", "🌶️", "🍛", "🥘", "🍚", "🫓"];
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
async function loadRecipes() {
  state.recipes = await api("/api/recipes");
  const g = $("#grid"); g.innerHTML = "";
  $("#gridEmpty").hidden = state.recipes.length > 0;
  state.recipes.forEach((it, idx) => {
    const h = hash(it.id), b = document.createElement("button");
    b.className = "book"; b.style.background = `linear-gradient(145deg, ${COVERS[h % COVERS.length]}, color-mix(in srgb, ${COVERS[h % COVERS.length]} 70%, #000))`;
    b.style.animationDelay = idx * 60 + "ms";
    b.innerHTML = `<div><span class="ico">${ICONS[h % ICONS.length]}</span><h3>${esc(it.recipe.title)}</h3><small>by ${esc(it.storyteller || "family")}</small></div>
      <div class="tags">${(it.recipe.tags || []).slice(0, 3).map(t => `<span>${esc(t)}</span>`).join("")}<span>${it.recipe.ingredients.length} ingredients</span></div>`;
    b.onclick = () => openRecipe(it);
    g.appendChild(b);
  });
}
function openRecipe(it) {
  const body = $("#dlgBody");
  body.innerHTML = recipeHTML(it.recipe, { by: it.storyteller, audio: it.audio }) +
    `<div class="dlg-bar"><button class="btn primary" id="cookBtn">👩‍🍳 Cooking mode</button>
     <button class="btn ghost" id="shareBtn">📋 Copy as text</button>
     <button class="btn ghost danger" id="delBtn">Delete</button>
     <button class="btn ghost" id="closeBtn" style="margin-left:auto">Close</button></div>`;
  $("#closeBtn").onclick = () => $("#dlg").close();
  $("#cookBtn").onclick = () => cookMode(it);
  $("#shareBtn").onclick = async () => { await navigator.clipboard?.writeText(recipeText(it)); toast("Recipe copied — send it to the family!"); };
  $("#delBtn").onclick = async () => {
    if (!confirm("Delete this recipe and its recording?")) return;
    await api("/api/recipes/" + it.id, { method: "DELETE" });
    $("#dlg").close(); toast("Deleted"); loadRecipes();
  };
  if (!$("#dlg").open) $("#dlg").showModal();
}
function recipeText(it) {
  const r = it.recipe;
  return `${r.title} (as told by ${it.storyteller})\n\n${r.story}\n\nIngredients\n${r.ingredients.map(i => `- ${i.amount} ${i.item}`.replace("-  ", "- ")).join("\n")}\n\nMethod\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`;
}
function cookMode(it) {
  const steps = it.recipe.steps; let i = 0;
  const body = $("#dlgBody");
  const draw = () => {
    body.innerHTML = `<div class="cook"><p class="count">${esc(it.recipe.title).toUpperCase()} · STEP ${i + 1} OF ${steps.length}</p>
      <div class="big">${esc(steps[i])}</div>
      <div class="nav2"><button class="btn ghost" id="pv" ${i === 0 ? "disabled" : ""}>← Back</button>
      <button class="btn primary" id="nx">${i === steps.length - 1 ? "Done 🎉" : "Next →"}</button></div>
      <p><button class="link-btn" id="ex">Exit cooking mode</button></p></div>`;
    $("#pv").onclick = () => { i--; draw(); };
    $("#nx").onclick = () => i === steps.length - 1 ? openRecipe(it) : (i++, draw());
    $("#ex").onclick = () => openRecipe(it);
  };
  draw();
}

/* ---------- printable book ---------- */
$("#printBtn").onclick = () => {
  if (!state.recipes.length) { toast("Save a recipe first"); return; }
  $("#printBook").innerHTML = `<section class="pcover"><div><h1>Our Family Recipes</h1><p>Told by the people we love</p></div></section>` +
    state.recipes.map(it => `<section class="prec">${recipeHTML(it.recipe, { by: it.storyteller }).replace(/<input type="checkbox">/g, "☐ ")}</section>`).join("");
  window.print();
};

/* ---------- init ---------- */
loadStatus(); loadRecipes(); setInterval(loadStatus, 15000);
