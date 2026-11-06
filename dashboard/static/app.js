'use strict';
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = async (path, opts) => {
  const r = await fetch(path, opts);
  return r.json();
};

const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

const fmtDate = t => new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const fmtSize = n => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const fmtRel = t => {
  const diff = Math.floor(Date.now() / 1000 - t);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
  return Math.floor(diff / 86400) + ' days ago';
};

const store = {
  get: (k, d) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function updateClock() {
  const el = $('#hud-clock');
  if (el) {
    const now = new Date();
    el.textContent = now.toTimeString().split(' ')[0] + ' LOC';
  }
}
setInterval(updateClock, 1000);
setTimeout(updateClock, 50);

let state = null;
let ports = [];
const HIST = 300;
const history = {}; // joint -> leader values (rolling)
const hist2 = {}; // joint -> follower actual values
let chartJoint = store.get('chartJoint', null);
let view3dMode = store.get('view3dMode', 'split');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), 2600);
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((res, rej) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? res() : rej();
    } catch (e) {
      rej(e);
    } finally {
      ta.remove();
    }
  });
}

function wireCopy() {
  view.querySelectorAll('[data-copy]').forEach(b => {
    b.onclick = () => {
      const text = b.parentElement.textContent.replace(/^Copy/, '').trim();
      copyText(text).then(
        () => toast('Copied to clipboard'),
        () => toast('Copy failed')
      );
    };
  });
}

/* ---------- Modal Handling ---------- */
const modal = $('#modal');
function openModal(title, sub, contentHtml) {
  $('#modal-title').textContent = title;
  $('#modal-sub').textContent = sub;
  $('#modal-body').innerHTML = contentHtml;
  modal.hidden = false;
}
function closeModal() {
  modal.hidden = true;
  $('#modal-body').innerHTML = '';
}
if ($('#modal-close-btn')) $('#modal-close-btn').onclick = closeModal;
if ($('#modal-close-backdrop')) $('#modal-close-backdrop').onclick = closeModal;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

/* ---------- Theme ---------- */
const themes = ['light', 'dark'];
function applyTheme() {
  const t = store.get('theme', 'light');
  if (t === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    $('#theme-label').textContent = 'Theme: Dark';
  } else {
    document.documentElement.removeAttribute('data-theme');
    $('#theme-label').textContent = 'Theme: Light';
  }
}
$('#theme').onclick = () => {
  const cur = store.get('theme', 'light');
  const next = cur === 'light' ? 'dark' : 'light';
  store.set('theme', next);
  applyTheme();
};
applyTheme();

/* ---------- Dashboard ---------- */
const JOINT_LABELS = {
  shoulder_pan: 'J1 Shoulder Pan',
  shoulder_lift: 'J2 Shoulder Lift',
  elbow_flex: 'J3 Elbow Flex',
  wrist_flex: 'J4 Wrist Flex',
  wrist_roll: 'J5 Wrist Roll',
  gripper: 'J6 Gripper',
};

function renderDashboard() {
  view.innerHTML = `
    <div class="top">
      <div>
        <h1>
          <span style="color:var(--neon-cyan);font-family:var(--font-mono);font-size:16px;letter-spacing:0.1em">// 01</span>
          TELEOPERATION COCKPIT
        </h1>
        <p class="sub">Bilateral Master-Follower Teleoperation Matrix · Real-time 60 Hz Kinematic Control Deck</p>
      </div>
      <div class="btns">
        <button id="rec" class="rec" title="Record joint telemetry to CSV">● REC TELEMETRY</button>
        <button id="start" class="primary">▶ ENGAGE TELEOP</button>
        <button id="stop" class="estop" title="Emergency Stop (Esc)">⚠ E-STOP (ESC)</button>
      </div>
    </div>

    <section class="card">
      <div class="top" style="margin-bottom:12px">
        <h2>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
          // PANEL 01 · 3D DIGITAL TWIN BAY
        </h2>
        <div class="cam-presets">
          <button id="mode-split" class="chip ${view3dMode === 'split' ? 'on' : ''}">SPLIT VIEW</button>
          <button id="mode-overlay" class="chip ${view3dMode === 'overlay' ? 'on' : ''}">GHOST OVERLAY</button>
        </div>
      </div>
      <div class="view3d" id="view3d">
        <span class="tag3d l" id="tag-leader" ${view3dMode === 'overlay' ? 'style="left:20px"' : ''}>LEADER // TEAL</span>
        <span class="tag3d f" id="tag-follower" ${view3dMode === 'overlay' ? 'style="left:150px;right:auto"' : ''}>FOLLOWER // WHITE</span>
        <span class="demo3d" id="demo3d"></span>
      </div>
      <div class="bar3d">
        <div class="cam-presets">
          <button id="cam-iso">ISOMETRIC</button>
          <button id="cam-front">FRONT</button>
          <button id="cam-top">TOP</button>
          <button id="cam-foll">FOLLOWER</button>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <label class="check" style="font-size:12px;color:var(--muted);font-family:var(--font-mono)">
            <input type="checkbox" id="demoToggle" ${store.get('demo', '1') === '1' ? 'checked' : ''}> IDLE SIMULATION
          </label>
          <button id="full3d">FULLSCREEN</button>
        </div>
      </div>
      <p class="note">Drag to orbit, scroll or pinch to zoom. Ghost Overlay superimposes both arms at origin to spot calibration lag and angular tracking errors.</p>
    </section>

    <section class="card">
      <h2>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
        // PANEL 02 · REAL-TIME TELEMETRY MATRIX
      </h2>
      <div class="stats">
        <div class="stat"><small>Loop Latency</small><b id="loop">–</b><div class="sub-val" id="sub-loop">TARGET: 16 MS</div></div>
        <div class="stat"><small>Cycle Rate</small><b id="hz">–</b><div class="sub-val" id="sub-hz">TARGET: 60 HZ</div></div>
        <div class="stat"><small>Mission Uptime</small><b id="up">–</b><div class="sub-val" id="frames">– FRAMES</div></div>
        <div class="stat"><small>Max Tracking Drift</small><b id="trk">–</b><div class="sub-val" id="trk-status">NOMINAL</div></div>
        <div class="stat"><small>Flight Recorder</small><b id="recst">OFF</b><div class="sub-val" id="rec-detail">STANDBY</div></div>
      </div>
      <div id="tags" style="margin-top:14px;display:flex;flex-wrap:wrap"></div>
      <div id="err" class="err" hidden></div>
    </section>

    <section class="card">
      <h2>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        // PANEL 03 · KINEMATICS &amp; MOTOR POSITIONS
      </h2>
      <div class="legend">
        <span><i class="l"></i>Leader Angle (Cyan)</span>
        <span><i class="f"></i>Follower Commanded (Green)</span>
        <span><i class="a"></i>Follower Measured Actual (Amber)</span>
      </div>
      <div id="joints"></div>
      <p class="note">Joints range from −100% to +100% (−110°…+110°); Gripper 0…100%. Stop releases motor torque immediately.</p>
    </section>

    <section class="card">
      <h2>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
        </svg>
        // PANEL 04 · TRAJECTORY SPECTRUM OSCILLOSCOPE
      </h2>
      <div class="chips" id="chips"></div>
      <div class="chartwrap">
        <canvas id="chart" width="960" height="260"></canvas>
      </div>
      <p class="note">Leader command (cyan) vs follower measured actual (amber) over rolling 30 seconds.</p>
    </section>

    <section class="card">
      <h2>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
        // PANEL 05 · AVIONICS &amp; SERIAL EVENT LOG
      </h2>
      <div id="log" class="log"></div>
    </section>`;

  if (Arm3D.mount($('#view3d'), { demo: store.get('demo', '1') === '1', mode: view3dMode })) {
    $('#full3d').onclick = () => {
      const v = $('#view3d');
      document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen && v.requestFullscreen();
    };
    $('#demoToggle').onchange = e => {
      store.set('demo', e.target.checked ? '1' : '0');
      Arm3D.setDemo(e.target.checked);
    };
    $('#cam-iso').onclick = () => Arm3D.setCameraPreset('iso');
    $('#cam-front').onclick = () => Arm3D.setCameraPreset('front');
    $('#cam-top').onclick = () => Arm3D.setCameraPreset('top');
    $('#cam-foll').onclick = () => Arm3D.setCameraPreset('follower');
    $('#mode-split').onclick = () => {
      view3dMode = 'split';
      store.set('view3dMode', 'split');
      $('#mode-split').classList.add('on');
      $('#mode-overlay').classList.remove('on');
      Arm3D.setMode('split');
    };
    $('#mode-overlay').onclick = () => {
      view3dMode = 'overlay';
      store.set('view3dMode', 'overlay');
      $('#mode-overlay').classList.add('on');
      $('#mode-split').classList.remove('on');
      Arm3D.setMode('overlay');
    };
  }

  $('#start').onclick = () => post('/api/start');
  $('#stop').onclick = () => post('/api/stop');
  $('#rec').onclick = async () => {
    const r = await post('/api/record', { on: !state.recording });
    if (r.error) toast(r.error);
  };

  $('#joints').innerHTML = state.joints
    .map(j => {
      const label = JOINT_LABELS[j] || j.replace('_', ' ');
      return `
    <div class="jrow" data-j="${j}">
      <div class="jname-wrap">
        <div class="jname">${label}</div>
        <div class="jdelta"><span class="delta-pill good" id="delta-${j}">Δ 0.0°</span></div>
      </div>
      <div class="bars">
        <div class="track" title="Leader position"><div class="fill l"></div></div>
        <div class="track" title="Commanded target"><div class="fill f"></div></div>
        <div class="track" title="Measured feedback"><div class="fill a"></div></div>
      </div>
      <div class="vals">
        L: <b class="lv">–</b> <span class="ldeg" style="color:var(--neon-cyan);font-size:11px">–</span><br>
        F: <b class="fv">–</b> · A: <b class="av">–</b> <span class="adeg" style="color:var(--neon-amber);font-size:11px">–</span>
      </div>
      <div class="spark-wrap">
        <canvas width="360" height="72"></canvas>
      </div>
    </div>`;
    })
    .join('');

  if (!chartJoint || !state.joints.includes(chartJoint)) chartJoint = state.joints[0];
  $('#chips').innerHTML = state.joints
    .map(j => `<button class="chip ${j === chartJoint ? 'on' : ''}" data-chip="${j}">${JOINT_LABELS[j] || j.replace('_', ' ')}</button>`)
    .join('');

  view.querySelectorAll('[data-chip]').forEach(b => {
    b.onclick = () => {
      chartJoint = b.dataset.chip;
      store.set('chartJoint', chartJoint);
      view.querySelectorAll('[data-chip]').forEach(x => x.classList.toggle('on', x === b));
      drawChart();
    };
  });
}

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';

function spark(canvas, data, gripper) {
  const ctx = canvas.getContext('2d'),
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;

  const lo = gripper ? 0 : -100,
    hi = 100;
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 2.2;
  ctx.shadowBlur = 0;

  // Subtle clean gradient fill under curve
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(2, 132, 199, 0.18)');
  grad.addColorStop(1, 'rgba(2, 132, 199, 0.0)');

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (HIST - 1)) * w;
    const y = h - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (h - 6) - 3;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

function drawChart() {
  const c = $('#chart');
  if (!c || !chartJoint) return;
  const ctx = c.getContext('2d'),
    w = c.width,
    h = c.height,
    g = chartJoint === 'gripper';
  ctx.clearRect(0, 0, w, h);

  // Background grid
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '11px "JetBrains Mono", monospace';
  ctx.shadowBlur = 0;

  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const y = 6 + f * (h - 12);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    const val = Math.round((g ? 100 : 100) - f * (g ? 100 : 200));
    const degVal = g ? val + '%' : (val * 1.1).toFixed(0) + '°';
    ctx.fillText(`${val}% [${degVal}]`, 8, y - 4);
  });

  const lo = g ? 0 : -100,
    hi = 100;
  const drawLine = (data, color, width) => {
    if (!data || data.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (HIST - 1)) * w;
      const y = h - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (h - 12) - 6;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  };

  drawLine(history[chartJoint] || [], '#0284c7', 2.4);
  drawLine(hist2[chartJoint] || [], '#d97706', 2.0);
}

function portTag(label, port) {
  const ok = ports.includes(port);
  return `<span class="tag ${ok ? 'ok' : ''}"><i></i>${label}: <b>${esc(port)}</b> ${ok ? '✓ online' : '✗ offline'}</span>`;
}

let tick = 0;
function updateDashboard(s) {
  if (!$('#start')) return;
  const running = s.status === 'running';

  $('#start').disabled = running || s.status === 'connecting';
  $('#stop').disabled = !running;
  $('#rec').disabled = !running;
  $('#rec').classList.toggle('on', !!s.recording);

  if (s.recording) {
    const dur = s.rec_duration ? s.rec_duration + 's' : '';
    $('#rec').textContent = `■ Stop REC (${dur})`;
    $('#recst').textContent = 'REC';
    $('#recst').style.color = 'var(--bad)';
    $('#rec-detail').textContent = `${s.rec_samples || 0} samples · ${dur}`;
  } else {
    $('#rec').textContent = '● Record';
    $('#recst').textContent = 'OFF';
    $('#recst').style.color = 'inherit';
    $('#rec-detail').textContent = 'ready to record';
  }

  $('#loop').textContent = s.loop_ms != null ? s.loop_ms + ' ms' : '–';
  $('#hz').textContent = s.loop_ms ? Math.round(Math.min(60, 1000 / s.loop_ms)) + ' Hz' : '–';
  $('#up').textContent = running && s.started_at ? Math.round(Date.now() / 1000 - s.started_at) + ' s' : '–';
  $('#frames').textContent = `${s.frames || 0} frames`;

  // Update Top Cockpit HUD Bar
  const hudLoop = $('#hud-loop-ms');
  if (hudLoop) hudLoop.textContent = s.loop_ms != null ? s.loop_ms + ' ms' : '-- ms';

  const hudSig = $('#hud-hz-signal');
  if (hudSig) {
    const hz = s.loop_ms ? Math.round(1000 / s.loop_ms) : 0;
    hudSig.textContent = hz >= 55 ? '●●●●●' : hz >= 40 ? '●●●●○' : hz >= 20 ? '●●●○○' : hz > 0 ? '●●○○○' : '○○○○○';
    hudSig.style.color = hz >= 50 ? 'var(--neon-emerald)' : hz >= 30 ? 'var(--neon-amber)' : 'var(--neon-red)';
  }

  const hudChip = $('#hud-status-chip');
  const hudLabel = $('#hud-status-label');
  if (hudLabel && hudChip) {
    if (s.recording) {
      hudLabel.textContent = `REC ACTIVE [${s.rec_duration || 0}s]`;
      hudChip.style.borderColor = 'var(--neon-red)';
      hudChip.style.color = 'var(--neon-red)';
    } else if (running) {
      hudLabel.textContent = 'TELEOP ACTIVE';
      hudChip.style.borderColor = 'var(--neon-emerald)';
      hudChip.style.color = 'var(--neon-emerald)';
    } else if (s.status === 'connecting') {
      hudLabel.textContent = 'LINK CONNECTING';
      hudChip.style.borderColor = 'var(--neon-amber)';
      hudChip.style.color = 'var(--neon-amber)';
    } else {
      hudLabel.textContent = 'SYS STANDBY';
      hudChip.style.borderColor = 'rgba(var(--neon-cyan-rgb), 0.35)';
      hudChip.style.color = 'var(--neon-cyan)';
    }
  }

  // Color stat cards by state
  const loopStat = $('#loop') && $('#loop').closest('.stat');
  if (loopStat && s.loop_ms != null) {
    loopStat.classList.remove('stat-ok', 'stat-warn', 'stat-bad', 'stat-accent');
    loopStat.classList.add(s.loop_ms < 20 ? 'stat-ok' : s.loop_ms < 40 ? 'stat-warn' : 'stat-bad');
  }
  const hzStat = $('#hz') && $('#hz').closest('.stat');
  if (hzStat) {
    hzStat.classList.remove('stat-ok', 'stat-warn', 'stat-bad', 'stat-accent');
    if (s.loop_ms) hzStat.classList.add(s.loop_ms < 20 ? 'stat-ok' : 'stat-warn');
  }

  const errs = Object.keys(s.actual || {}).map(j => Math.abs((s.actual[j] ?? 0) - (s.follower[j] ?? 0)));
  const maxErr = errs.length ? Math.max(...errs) : null;
  $('#trk').textContent = maxErr != null ? maxErr.toFixed(1) + '%' : '–';

  const trkStatus = $('#trk-status');
  const trkStat = $('#trk') && $('#trk').closest('.stat');
  if (trkStatus) {
    if (maxErr == null) {
      trkStatus.textContent = 'no data';
      if (trkStat) { trkStat.classList.remove('stat-ok', 'stat-warn', 'stat-bad'); }
    } else if (maxErr < 3.0) {
      trkStatus.textContent = 'nominal (excellent)';
      trkStatus.style.color = 'var(--ok)';
      if (trkStat) { trkStat.classList.remove('stat-warn', 'stat-bad'); trkStat.classList.add('stat-ok'); }
    } else if (maxErr < 7.0) {
      trkStatus.textContent = 'moderate lag';
      trkStatus.style.color = 'var(--warn)';
      if (trkStat) { trkStat.classList.remove('stat-ok', 'stat-bad'); trkStat.classList.add('stat-warn'); }
    } else {
      trkStatus.textContent = 'divergence alert';
      trkStatus.style.color = 'var(--bad)';
      if (trkStat) { trkStat.classList.remove('stat-ok', 'stat-warn'); trkStat.classList.add('stat-bad'); }
    }
  }

  // Update sidebar live stats + status glow
  if ($('#side-loop')) $('#side-loop').textContent = s.loop_ms != null ? s.loop_ms + ' ms' : '-- ms';
  if ($('#side-hz')) $('#side-hz').textContent = s.loop_ms ? Math.round(Math.min(60, 1000 / s.loop_ms)) + ' Hz' : '-- Hz';

  $('#err').hidden = !s.error;
  $('#err').textContent = s.error || '';

  const logEl = $('#log');
  if (logEl) {
    logEl.innerHTML =
      [...s.events]
        .reverse()
        .map(e => {
          const isErr = /error|fail|diverg/i.test(e.msg);
          const isWarn = /warn|slow|delay/i.test(e.msg);
          const tag = isErr ? '<span style="color:var(--neon-red);font-weight:700">[ERR]</span> ' : isWarn ? '<span style="color:var(--neon-amber);font-weight:700">[WARN]</span> ' : '<span style="color:var(--neon-cyan);font-weight:700">[SYS]</span> ';
          return `<div><time>${new Date(e.t * 1000).toLocaleTimeString()}</time>${tag}${esc(e.msg)}</div>`;
        })
        .join('') || '<div>No events logged yet.</div>';
  }

  const bar = (el, v, g) => {
    const lo = g ? 0 : -100;
    el.style.width = Math.max(0, Math.min(100, ((v - lo) / (100 - lo)) * 100)) + '%';
  };

  document.querySelectorAll('.jrow').forEach(r => {
    const j = r.dataset.j,
      g = j === 'gripper',
      l = s.leader[j],
      f = s.follower[j],
      a = s.actual[j];
    const set = (sel, v) => {
      r.querySelector(sel).textContent = v != null ? v.toFixed(1) + '%' : '–';
    };
    set('.lv', l);
    set('.fv', f);
    set('.av', a);

    const deg = (val, isGrip) => {
      if (val == null) return '';
      if (isGrip) return `(${val.toFixed(0)}%)`;
      return `${(val * 1.1).toFixed(1)}°`;
    };
    const ldeg = r.querySelector('.ldeg');
    if (ldeg) ldeg.textContent = deg(l, g);
    const adeg = r.querySelector('.adeg');
    if (adeg) adeg.textContent = deg(a, g);

    if (l != null) bar(r.querySelector('.fill.l'), l, g);
    if (f != null) bar(r.querySelector('.fill.f'), f, g);
    if (a != null) bar(r.querySelector('.fill.a'), a, g);

    // Delta tracking error
    const deltaEl = r.querySelector(`#delta-${j}`);
    if (deltaEl && l != null && a != null) {
      const diff = Math.abs(a - l);
      deltaEl.textContent = `Δ ${diff.toFixed(1)}%`;
      deltaEl.className = 'delta-pill ' + (diff < 3.0 ? 'good' : diff < 7.0 ? 'warn' : 'bad');
    }

    if (running && l != null) {
      const h = history[j] || (history[j] = []);
      h.push(l);
      if (h.length > HIST) h.shift();
      const h2 = hist2[j] || (hist2[j] = []);
      h2.push(a ?? l);
      if (h2.length > HIST) h2.shift();
      spark(r.querySelector('canvas'), h, g);
    }
  });

  drawChart();
  Arm3D.update(s.leader, Object.keys(s.actual || {}).length ? s.actual : s.follower);

  const dm = $('#demo3d');
  if (dm) dm.textContent = running ? '' : store.get('demo', '1') === '1' ? 'Simulation mode active' : '';

  if (tick++ % 20 === 0) refreshPorts();
}

async function refreshPorts() {
  try {
    const c = await api('/api/config');
    ports = c.ports;

    const hudArch = $('#hud-arch');
    if (hudArch && c.config.robot_type) hudArch.textContent = c.config.robot_type.toUpperCase() + ' MK-II';
    const hudPorts = $('#hud-ports');
    if (hudPorts) {
      const p1 = (c.config.follower_port || '').split('/').pop() || 'OFFLINE';
      const p2 = (c.config.leader_port || '').split('/').pop() || 'OFFLINE';
      hudPorts.textContent = `${p2} ➔ ${p1}`;
    }

    const tags = $('#tags');
    if (tags) {
      tags.innerHTML =
        portTag('Follower', c.config.follower_port) +
        portTag('Leader', c.config.leader_port) +
        `<span class="tag ok"><i></i>Arm: <b>${esc(c.config.robot_type.toUpperCase())}</b>${
          +c.config.max_relative_target ? ' · step limit ' + c.config.max_relative_target : ''
        }</span>`;
    }
  } catch {
    /* ignore */
  }
}

/* ---------- Recordings & In-Browser Preview ---------- */
async function renderRecordings() {
  const { recordings } = await api('/api/recordings');

  const episodeCards = recordings.map((r, idx) => {
    const epNum = String(idx + 1).padStart(3, '0');
    return `
    <div class="ep-card">
      <div class="ep-meta">
        <div class="ep-num">EP ${epNum}</div>
        <div>
          <div class="ep-name">${esc(r.name)}</div>
          <div class="ep-time">${fmtDate(r.modified)} · ${fmtRel(r.modified)} · ${fmtSize(r.size)}</div>
        </div>
      </div>
      <div class="ep-actions">
        <button class="btn" data-prev="${esc(r.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
          Preview
        </button>
        <a class="btn" href="/recordings/${encodeURIComponent(r.name)}" download>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          Download
        </a>
        <button class="danger" data-del="${esc(r.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
        </button>
      </div>
    </div>`;
  }).join('') || `<div style="text-align:center;padding:36px;color:var(--muted)">
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:10px;opacity:0.4"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
    <div>No recordings found. Start teleoperation and click <b>Record</b> to capture episodes.</div>
  </div>`;

  view.innerHTML = `
    <div class="top">
      <div>
        <h1>
          <span style="color:var(--neon-cyan);font-family:var(--font-mono);font-size:16px;letter-spacing:0.1em">// 02</span>
          FLIGHT RECORDER EPISODES
        </h1>
        <p class="sub">30 Hz Bilateral Telemetry Datasets · Commanded vs Actual Joint Angular Trajectories</p>
      </div>
      <span class="badge" style="font-size:11.5px;padding:6px 14px;border-color:var(--neon-cyan);color:var(--neon-cyan)">${recordings.length} EPISODES LOGGED</span>
    </div>
    <section class="card">
      <div class="ep-list">${episodeCards}</div>
    </section>`;

  // Wire Preview modal
  view.querySelectorAll('[data-prev]').forEach(b => {
    b.onclick = async () => {
      const name = b.dataset.prev;
      openModal('Loading Episode Trajectory…', name, '<p style="color:var(--muted)">Fetching and parsing trajectory data…</p>');
      try {
        const data = await api(`/api/recordings/preview?name=${encodeURIComponent(name)}`);
        if (data.error) {
          $('#modal-body').innerHTML = `<div class="err">${esc(data.error)}</div>`;
          return;
        }

        const joints = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];
        const colors = ['#0284c7', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2'];

        $('#modal-sub').textContent = `${data.total_rows} recorded frames · ${data.duration}s duration · file: ${name}`;
        $('#modal-body').innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
            <div style="display:flex;gap:16px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">
              <span>DURATION: <b style="color:var(--text)">${data.duration}s</b></span>
              <span>SAMPLES: <b style="color:var(--text)">${data.total_rows}</b></span>
            </div>
            <div style="display:flex;gap:8px">
              <a class="btn primary" href="/recordings/${encodeURIComponent(name)}" download>Download CSV</a>
            </div>
          </div>
          <div class="chartwrap" style="background:#ffffff;border-radius:8px;padding:12px;border:1px solid #e2e8f0">
            <canvas id="prev-chart" width="800" height="320" style="width:100%;height:320px;display:block"></canvas>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:14px;font-size:12px;font-family:var(--font-mono)">
            ${joints.map((j, i) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colors[i]};margin-right:6px"></i>${JOINT_LABELS[j] || j}</span>`).join('')}
          </div>`;

        // Render preview canvas
        const canvas = $('#prev-chart');
        const ctx = canvas.getContext('2d'),
          w = canvas.width,
          h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Grid lines
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#64748b';
        ctx.font = '11px "JetBrains Mono", monospace';
        [0, 0.25, 0.5, 0.75, 1].forEach(f => {
          const y = 6 + f * (h - 12);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          const val = Math.round(100 - f * 200);
          ctx.fillText(`${val}% [${(val * 1.1).toFixed(0)}°]`, 6, y - 4);
        });

        const samples = data.samples;
        if (!samples.length) return;

        joints.forEach((joint, jIdx) => {
          const colIdx = data.header.indexOf(`leader_${joint}`);
          if (colIdx === -1) return;
          ctx.strokeStyle = colors[jIdx];
          ctx.lineWidth = 2.2;
          ctx.shadowBlur = 0;
          ctx.beginPath();
          samples.forEach((row, i) => {
            const v = parseFloat(row[colIdx]);
            if (isNaN(v)) return;
            const x = (i / (samples.length - 1)) * w;
            const y = h - ((Math.max(-100, Math.min(100, v)) + 100) / 200) * (h - 12) - 6;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          });
          ctx.stroke();
        });
      } catch (e) {
        $('#modal-body').innerHTML = `<div class="err">${esc(e.message)}</div>`;
      }
    };
  });

  view.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Are you sure you want to delete ' + b.dataset.del + '?')) return;
      await post('/api/recordings/delete', { name: b.dataset.del });
      renderRecordings();
    };
  });
}

/* ---------- Calibration ---------- */
async function renderCalibration() {
  view.innerHTML = '<h1>Calibration</h1><p class="sub">Scanning calibration profiles…</p>';
  const [cal, { config }] = await Promise.all([api('/api/calibrations'), api('/api/config')]);

  const section = (kind, title, activeId) => {
    const rows = cal[kind]
      .map(f => {
        const spans = Object.values(f.joints)
          .filter(j => j.range_min != null)
          .map(j => j.range_max - j.range_min);
        const avg = spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : '–';
        const detail = Object.entries(f.joints)
          .map(([n, j]) => {
            const span = j.range_max != null && j.range_min != null ? j.range_max - j.range_min : 0;
            const pct = Math.min(100, Math.max(10, (span / 4096) * 100));
            return `
            <tr>
              <td><b>${JOINT_LABELS[n] || esc(n)}</b></td>
              <td class="num">${j.id}</td>
              <td class="num">${j.homing_offset}</td>
              <td class="num">${j.range_min}</td>
              <td class="num">${j.range_max}</td>
              <td>
                <div class="cal-range-bar">
                  <div class="cal-range-track"><div class="cal-range-fill" style="width:${pct.toFixed(0)}%"></div></div>
                  <span>${span} ticks</span>
                </div>
              </td>
            </tr>`;
          })
          .join('');

        const sel = f.id === activeId;
        return `
          <tr class="${sel ? 'sel' : ''}">
            <td><b>${esc(f.id)}</b>${sel ? '<span class="pill">ACTIVE</span>' : ''}</td>
            <td>${fmtDate(f.modified)} <div style="font-size:11.5px;color:var(--dim)">${fmtRel(f.modified)}</div></td>
            <td class="num">${Object.keys(f.joints).length} motors</td>
            <td class="num">${avg} ticks</td>
            <td><button class="btn ${sel ? '' : 'primary'}" data-use="${kind}:${esc(f.id)}" ${sel ? 'disabled' : ''}>${sel ? 'In Use' : 'Activate'}</button></td>
          </tr>
          <tr>
            <td colspan="5" style="padding:0;border:0">
              <details class="joint-detail" style="padding:8px 14px">
                <summary style="font-weight:600;color:var(--muted)">Inspect Motor Limits &amp; Zero Offsets</summary>
                <table>
                  <tr><th>Joint</th><th>ID</th><th>Homing Offset</th><th>Min Limit</th><th>Max Limit</th><th>Usable Travel</th></tr>
                  ${detail}
                </table>
              </details>
            </td>
          </tr>`;
      })
      .join('') || '<tr><td colspan="5">No calibration profiles found.</td></tr>';

    return `
      <section class="card">
        <h2>${title}</h2>
        <table>
          <tr><th>Profile ID</th><th>Last Calibrated</th><th>Configured Motors</th><th>Average Range</th><th></th></tr>
          ${rows}
        </table>
      </section>`;
  };

  view.innerHTML = `
    <h1>
      <span style="color:var(--neon-cyan);font-family:var(--font-mono);font-size:16px;letter-spacing:0.1em">// 03</span>
      ACTUATOR CALIBRATION
    </h1>
    <p class="sub">Servo Zero-Offsets, Hardstop Discovery &amp; Usable Travel Limits</p>
    ${section('follower', 'Follower Arm Calibration', config.follower_id)}
    ${section('leader', 'Leader Arm Calibration', config.leader_id)}
    <section class="card">
      <h2>Calibrate From Terminal</h2>
      <p class="note" style="margin-top:0">Motor calibration requires manual range-of-motion discovery. Stop teleoperation before executing in your terminal:</p>
      <pre><button data-copy>Copy</button>lerobot-calibrate --robot.type=${esc(config.robot_type)}_follower --robot.port=${esc(config.follower_port)} --robot.id=NEW_FOLLOWER_ID</pre>
      <pre><button data-copy>Copy</button>lerobot-calibrate --teleop.type=${esc(config.robot_type)}_leader --teleop.port=${esc(config.leader_port)} --teleop.id=NEW_LEADER_ID</pre>
    </section>`;

  view.querySelectorAll('[data-use]').forEach(b => {
    b.onclick = async () => {
      const [kind, id] = b.dataset.use.split(':');
      const r = await post('/api/config', { [kind + '_id']: id });
      if (r.error) toast(r.error);
      else {
        toast(`Activated ${kind} → ${id}`);
        renderCalibration();
      }
    };
  });
  wireCopy();
}

/* ---------- Settings ---------- */
async function renderSettings() {
  const [{ config, ports: pp, locked, robot_types }, cal] = await Promise.all([api('/api/config'), api('/api/calibrations')]);
  const opts = (list, val) => [...new Set([val, ...list])].map(p => `<option ${p === val ? 'selected' : ''}>${esc(p)}</option>`).join('');

  view.innerHTML = `
    <h1>
      <span style="color:var(--neon-cyan);font-family:var(--font-mono);font-size:16px;letter-spacing:0.1em">// 04</span>
      HARDWARE BUS &amp; SAFETY LIMITS
    </h1>
    <p class="sub">Serial Interfaces, Kinematics Architecture, and Acceleration Velocity Guards.${
      locked ? ' <b style="color:var(--warn)">[Locked while teleoperation is active]</b>' : ''
    }</p>
    
    <section class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h2>Serial Port Assignment</h2>
        <button id="rescan-ports" class="btn" style="font-size:12px;padding:4px 12px">⚡ Rescan USB Ports</button>
      </div>
      <div class="grid2">
        <div>
          <h3>Follower Arm</h3>
          <div class="field">
            <label for="fp">Follower Serial Device</label>
            <select id="fp">${opts(pp, config.follower_port)}</select>
          </div>
          <div class="field">
            <label for="fi">Calibration Profile</label>
            <select id="fi">${opts(cal.follower.map(f => f.id), config.follower_id)}</select>
          </div>
        </div>
        <div>
          <h3>Leader Arm</h3>
          <div class="field">
            <label for="lp">Leader Serial Device</label>
            <select id="lp">${opts(pp, config.leader_port)}</select>
          </div>
          <div class="field">
            <label for="li">Calibration Profile</label>
            <select id="li">${opts(cal.leader.map(f => f.id), config.leader_id)}</select>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Robotics Safety &amp; Kinematics</h2>
      <div class="grid2">
        <div class="field">
          <label for="rt">Arm Model Architecture</label>
          <select id="rt">${opts(robot_types, config.robot_type)}</select>
          <div class="hint">Select SO-100 or SO-101 motor bus architecture.</div>
        </div>
        <div class="field">
          <label for="mr">Max Step Per Frame (Safety Velocity Guard)</label>
          <input id="mr" type="number" min="0" max="100" step="1" value="${+config.max_relative_target}">
          <div class="hint">Limits instantaneous jump per frame (0 = unlimited). Setting 5–10 ensures gentle follower acceleration.</div>
        </div>
      </div>
      <button id="save" class="primary" ${locked ? 'disabled' : ''}>Save Settings</button>
      <p class="note">Currently detected serial interfaces: <code>${pp.map(esc).join(', ') || 'none detected'}</code>.</p>
    </section>

    <section class="card">
      <h2>Remote Network Access (LAN)</h2>
      <p class="note" style="margin-top:0">To open this control studio from a tablet, phone, or remote workstation on the local network:</p>
      <pre><button data-copy>Copy</button>python dashboard/server.py --allow-lan</pre>
    </section>`;

  $('#save').onclick = async () => {
    const r = await post('/api/config', {
      follower_port: $('#fp').value,
      follower_id: $('#fi').value,
      leader_port: $('#lp').value,
      leader_id: $('#li').value,
      robot_type: $('#rt').value,
      max_relative_target: Number($('#mr').value) || 0,
    });
    toast(r.error || 'Settings saved successfully');
  };

  const rescanBtn = $('#rescan-ports');
  if (rescanBtn) {
    rescanBtn.onclick = async () => {
      rescanBtn.disabled = true;
      rescanBtn.textContent = 'Scanning…';
      try {
        const { ports: newPorts } = await api('/api/ports');
        ports = newPorts;
        toast(`Found ${ports.length} serial device(s)`);
        renderSettings();
      } catch {
        toast('Rescan failed');
        rescanBtn.disabled = false;
      }
    };
  }

  wireCopy();
}

/* ---------- Guide ---------- */
function renderGuide() {
  view.innerHTML = `
    <h1>
      <span style="color:var(--neon-cyan);font-family:var(--font-mono);font-size:16px;letter-spacing:0.1em">// 05</span>
      OPERATIONS MANUAL &amp; PROTOCOL
    </h1>
    <p class="sub">Bilateral Master-Follower Teleoperation Workflow, Field Diagnostics &amp; CLI Control</p>

    <div class="info-banner">
      <b>Safety Notice:</b> The follower arm engages high-torque servomotors immediately upon clicking <i>Start Teleoperation</i>. Ensure your hands and loose objects are clear of the physical robot's reach before starting.
    </div>

    <section class="card">
      <h2>Quick Start Protocol</h2>
      <ol class="steps">
        <li>Connect both arms to USB and external 7.4V/12V power supply. Check port mapping in <a href="#/settings">Settings</a>.</li>
        <li>Select the verified calibration profiles in <a href="#/calibration">Calibration</a>.</li>
        <li>Align the leader arm loosely with the follower's physical resting position. Clear the workspace.</li>
        <li>Click <b>Start Teleoperation</b> on the Dashboard. Follower motors will engage and mirror the leader in real time.</li>
        <li>Use <b>Record</b> to capture high-rate training episodes to CSV.</li>
        <li>Click <b>Stop</b> or tap <kbd>Esc</kbd> when finished. Follower torque disables safely upon stopping.</li>
      </ol>
    </section>

    <section class="card">
      <h2>Studio Keyboard Shortcuts</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:12px;margin-top:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--card-sub);border-radius:8px;border:1px solid var(--line)">
          <span style="font-size:13.5px">Emergency Stop Teleoperation</span>
          <kbd style="padding:3px 8px;font-weight:700">Esc</kbd>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--card-sub);border-radius:8px;border:1px solid var(--line)">
          <span style="font-size:13.5px">Close Trajectory Modal</span>
          <kbd style="padding:3px 8px;font-weight:700">Esc</kbd>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--card-sub);border-radius:8px;border:1px solid var(--line)">
          <span style="font-size:13.5px">Orbit 3D Digital Twin</span>
          <span style="font-size:12px;color:var(--muted);font-family:var(--font-mono)">Left Click + Drag</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--card-sub);border-radius:8px;border:1px solid var(--line)">
          <span style="font-size:13.5px">Pan 3D Digital Twin</span>
          <span style="font-size:12px;color:var(--muted);font-family:var(--font-mono)">Right Click + Drag</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--card-sub);border-radius:8px;border:1px solid var(--line)">
          <span style="font-size:13.5px">Zoom Camera</span>
          <span style="font-size:12px;color:var(--muted);font-family:var(--font-mono)">Scroll Wheel / Pinch</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--card-sub);border-radius:8px;border:1px solid var(--line)">
          <span style="font-size:13.5px">Cycle Color Themes</span>
          <span style="font-size:12px;color:var(--muted);font-family:var(--font-mono)">Sidebar Theme Button</span>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Diagnostics &amp; Common Issues</h2>
      <details>
        <summary>“No module named scservo_sdk” or Feetech driver error</summary>
        <p>Ensure the Feetech servo SDK is installed in your python environment:</p>
        <pre><button data-copy>Copy</button>pip install "feetech-servo-sdk>=1.0.0,&lt;2.0.0"</pre>
      </details>
      <details>
        <summary>Permission denied on /dev/ttyACM* or /dev/ttyUSB*</summary>
        <p>Add your Linux user to the serial dialout group, then log out and back in:</p>
        <pre><button data-copy>Copy</button>sudo usermod -a -G dialout $USER</pre>
      </details>
      <details>
        <summary>Follower arm jumps violently on start</summary>
        <p>Set a safety step limit under <a href="#/settings">Settings</a> (e.g. <code>5</code> or <code>8</code>) to restrict maximum position deltas per frame.</p>
      </details>
      <details>
        <summary>Web UI shows “Connection lost — attempting reconnect”</summary>
        <p>The dashboard backend was closed. Restart with <code>python dashboard/server.py</code>.</p>
      </details>
    </section>

    <section class="card">
      <h2>Direct LeRobot CLI Commands</h2>
      <pre><button data-copy>Copy</button>lerobot-teleoperate --robot.type=so101_follower --robot.port=/dev/ttyACM1 --robot.id=makerworks_follower_arm --teleop.type=so101_leader --teleop.port=/dev/ttyACM0 --teleop.id=makerworks_leader_arm</pre>
      <pre><button data-copy>Copy</button>lerobot-find-port</pre>
    </section>`;
  wireCopy();
}

/* ---------- Router & Polling ---------- */
const routes = {
  dashboard: renderDashboard,
  recordings: renderRecordings,
  calibration: renderCalibration,
  settings: renderSettings,
  guide: renderGuide,
};

function route() {
  if (!state) return;
  Arm3D.unmount();
  const r = location.hash.replace('#/', '') || 'dashboard';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.route === r));
  (routes[r] || renderDashboard)();
  if (r === 'dashboard') {
    refreshPorts();
    updateDashboard(state);
  }
  window.scrollTo(0, 0);
}

let fails = 0;
async function poll() {
  try {
    state = await api('/api/state');
    fails = 0;
    $('#banner').hidden = true;
    $('#badge').className = 'badge ' + state.status;
    $('#status').textContent = state.status;
    if (state.status === 'running') {
      document.body.classList.add('running-glow');
    } else {
      document.body.classList.remove('running-glow');
    }
    if (!view.children.length) route();
    updateDashboard(state);
  } catch {
    if (++fails >= 3) {
      $('#banner').hidden = false;
      $('#status').textContent = 'offline';
      $('#badge').className = 'badge error';
    }
  }
  setTimeout(poll, fails ? 1000 : 100);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state && state.status === 'running') {
    post('/api/stop');
    toast('Emergency stop triggered');
  }
});

window.addEventListener('hashchange', route);
poll();

