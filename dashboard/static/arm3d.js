/* Copyright 2026 Ajay Ummadi (MakerWorks Lab). Licensed under the Apache License, Version 2.0; see the LICENSE file at the root of this repository. */
'use strict';
/* 3D digital twin built from the official SO-101 CAD (URDF + STL meshes in /so101, from
 * TheRobotStudio/SO-ARM100). Follower = white arm with the two-jaw gripper; leader = teal arm
 * with the official hand handle and trigger. Joint angles are approximate; tune the TUNE table if a joint moves the wrong way.
 */
const Arm3D = (() => {
  const D2R = Math.PI / 180;
  // radians at +100 / -100 (URDF joint limits); `sign` flips a joint that moves the wrong way
  const TUNE = {
    pan:   { pos: 110, neg: 110, sign: 1 },
    lift:  { pos: 100, neg: 100, sign: 1 },
    elbow: { pos: 90,  neg: 100, sign: 1 },
    wflex: { pos: 95,  neg: 95,  sign: 1 },
    wroll: { pos: 160, neg: 160, sign: 1 },
    grip:  { pos: 100, neg: 10,  sign: 1 },   // gripper is 0..100 -> jaw 0..100 degrees
  };
  const JOINTS = {
    follower: { pan: 'Rotation', lift: 'Pitch', elbow: 'Elbow', wflex: 'Wrist_Pitch', wroll: 'Wrist_Roll', grip: 'Jaw' },
    leader: { pan: 'shoulder_pan', lift: 'shoulder_lift', elbow: 'elbow_flex', wflex: 'wrist_flex', wroll: 'wrist_roll', grip: 'gripper' },
  };
  const URDF = { follower: '/so101/so101.urdf', leader: '/so101/so101_leader.urdf' };
  // the leader URDF has slightly different limits (elbow +/-97 deg, trigger 0..45 deg)
  const signFix = { leader: { pan: 1, lift: 1, elbow: 1, wflex: 1, wroll: 1, grip: 1 } };   // filled in by alignLeaderToFollower()
  const LEADER_TUNE = { elbow: { pos: 97, neg: 97 }, grip: { pos: 45 } };
  const span = (t, v) => t.sign * (t.fix ?? 1) * (v >= 0 ? v * t.pos : v * t.neg) / 100 * D2R;
  const pose = (v, kind = 'follower') => {
    const t = k => ({ ...TUNE[k], ...(kind === 'leader' ? LEADER_TUNE[k] : {}), fix: kind === 'leader' ? signFix.leader[k] : 1 });
    return {
      pan: span(t('pan'), v.shoulder_pan ?? 0), lift: span(t('lift'), v.shoulder_lift ?? 0),
      elbow: span(t('elbow'), v.elbow_flex ?? 0), wflex: span(t('wflex'), v.wrist_flex ?? 0),
      wroll: span(t('wroll'), v.wrist_roll ?? 0), grip: t('grip').sign * t('grip').fix * Math.max(0, v.gripper ?? 0) / 100 * t('grip').pos * D2R,
    };
  };
  const ZERO = { pan: 0, lift: 0, elbow: 0, wflex: 0, wroll: 0, grip: 0.1 };

  const COLORS = { leader: 0x1fa797, follower: 0xf2f2ee, servo: 0x16181c, clamp: 0xc4282d };
  const SPLIT_X = 24;

  let renderer, scene, camera, controls, host, raf = 0, ro, arms = null;
  let opts = { demo: true, mode: 'split' };
  let target = { leader: null, follower: null }, lastData = 0, t0 = 0;
  const available = () => typeof THREE !== 'undefined' && !!THREE.STLLoader;


  /* ---------- realism helpers ---------- */
  // STL files only carry flat per-face normals. Smooth them across shallow edges (< angle) and keep sharp
  // creases, which is what makes printed parts look like real moulded plastic instead of faceted toys.
  function creasedNormals(geo, angleDeg = 38) {
    if (geo.userData.creased) return;
    const pos = geo.attributes.position, n = pos.count, cosT = Math.cos(angleDeg * D2R);
    const fn = new Float32Array(n * 3), area = new Float32Array(n);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const groups = new Map();
    const key = i => ((Math.round(pos.getX(i) * 1e4) + 4000) * 8192 + (Math.round(pos.getY(i) * 1e4) + 4000)) * 8192 + (Math.round(pos.getZ(i) * 1e4) + 4000);
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      const f = c.clone().sub(b).cross(a.clone().sub(b)); const w = f.length(); f.normalize();
      for (let k = 0; k < 3; k++) { fn.set([f.x, f.y, f.z], (i + k) * 3); area[i + k] = w; }
    }
    for (let i = 0; i < n; i++) { const k = key(i); (groups.get(k) || groups.set(k, []).get(k)).push(i); }
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0, z = 0;
      for (const j of groups.get(key(i))) {
        if (fn[i * 3] * fn[j * 3] + fn[i * 3 + 1] * fn[j * 3 + 1] + fn[i * 3 + 2] * fn[j * 3 + 2] >= cosT) {
          x += fn[j * 3] * area[j]; y += fn[j * 3 + 1] * area[j]; z += fn[j * 3 + 2] * area[j];
        }
      }
      const l = Math.hypot(x, y, z) || 1; out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
    geo.userData.creased = true;
  }

  // soft studio lighting baked into an environment map (big overhead softbox + side and back fills)
  function studioEnvironment(r) {
    const pm = new THREE.PMREMGenerator(r), env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.BoxGeometry(200, 120, 200), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xb9c0cc), side: THREE.BackSide })));
    const box = (w, h, x, y, z, rx, ry, v) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(v), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.rotation.set(rx, ry, 0); env.add(m);
    };
    box(90, 90, 0, 58, 0, Math.PI / 2, 0, 5);          // overhead softbox
    box(60, 50, 60, 25, 40, 0, -Math.PI / 3, 3);        // key (front-right)
    box(60, 50, -70, 25, 10, 0, Math.PI / 2.4, 2);      // fill (left)
    box(80, 40, 0, 20, -70, 0, 0, 1.6);                 // back
    const tex = pm.fromScene(env, .03).texture; pm.dispose(); return tex;
  }

  // the real wires: red/white/black strands between consecutive servos, re-drawn every frame so they follow the joints
  const CABLE_COLORS = [0x15161a, 0xc0221f, 0xf1f1ee];
  function buildCables(arm, model) {
    const kinds = [], order = [model.root], seen = new Set([model.root]);
    for (let i = 0; i < order.length; i++) for (const j of model.joints) if (j.parent === order[i] && !seen.has(j.child)) { seen.add(j.child); order.push(j.child); }
    for (const name of order) {
      const sv = (model.links[name] || []).find(v => v.servo);
      if (sv) kinds.push({ link: arm.links[name], p: new THREE.Vector3(...sv.xyz) });
    }
    arm.cables = [];
    const mats = CABLE_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: .55, metalness: .05 }));
    arm.materials.push(...mats);
    for (let i = 0; i + 1 < kinds.length; i++) {
      const strands = mats.map(m => { const t = new THREE.Mesh(new THREE.BufferGeometry(), m); t.castShadow = true; t.frustumCulled = false; arm.root.add(t); return t; });
      arm.cables.push({ a: kinds[i], b: kinds[i + 1], strands, side: i % 2 ? 1 : -1 });
    }
  }
  const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _d = new THREE.Vector3(), _s = new THREE.Vector3(), _bn = new THREE.Vector3();
  function updateCables(arm) {
    if (!arm.ready || !arm.cables) return;
    arm.root.updateMatrixWorld(true);
    for (const c of arm.cables) {
      _p0.copy(c.a.p); c.a.link.localToWorld(_p0); arm.root.worldToLocal(_p0);
      _p1.copy(c.b.p); c.b.link.localToWorld(_p1); arm.root.worldToLocal(_p1);
      _d.subVectors(_p1, _p0); const len = _d.length();
      _s.set(c.side, 0, 0);                       // wires bulge sideways and sag a little, like slack cable
      _bn.crossVectors(_d, _s).normalize();
      const pts = [0, .3, .65, 1].map((t, i) => {
        const bulge = Math.sin(Math.PI * t) * len * .22;
        return _p0.clone().lerp(_p1, t).addScaledVector(_s, bulge).add(new THREE.Vector3(0, -Math.sin(Math.PI * t) * len * .06, 0));
      });
      const curve = new THREE.CatmullRomCurve3(pts);
      c.strands.forEach((m, i) => {
        const off = (i - 1) * .26, cp = curve.points.map(p => p.clone().addScaledVector(_bn, off));
        m.geometry.dispose(); m.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cp), 22, .12, 5);
      });
    }
  }


  /* ---------- table, clamps, driver board and the handwritten port label (from the photos) ---------- */
  function markerLabel(lines) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 192;
    const g = c.getContext('2d');
    g.translate(128, 96); g.rotate(-.08);
    g.fillStyle = '#14161c'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const font = '"Segoe Print","Bradley Hand","Comic Sans MS","Marker Felt",cursive';
    lines.forEach((t, i) => {
      g.font = `bold ${i ? 60 : 78}px ${font}`;
      const y = (i - (lines.length - 1) / 2) * 74;
      g.fillText(t, 0, y); g.fillText(t, 1.4, y + 1);          // double stroke = marker ink
    });
    const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4; return tex;
  }

  function clampMesh(mat, pad) {
    const g = new THREE.Group();
    // C-frame seen from the side (u -> scene z, v -> y): spine outside the table edge, jaws above and below it
    const sh = new THREE.Shape();
    [[1.5, -4.4], [7.3, -4.4], [7.3, 4.2], [2.8, 4.2], [2.8, 3.0], [5.9, 3.0], [5.9, -3.2], [1.5, -3.2]].forEach(([u, v], i) => (i ? sh.lineTo(u, v) : sh.moveTo(u, v)));
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 1.4, bevelEnabled: true, bevelSize: .15, bevelThickness: .15, bevelSegments: 2 });
    geo.translate(0, 0, -.7); geo.rotateY(-Math.PI / 2);
    g.add(new THREE.Mesh(geo, mat));
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(.38, .38, 5.2, 14), mat); screw.position.set(0, 3.5, 4.0); g.add(screw);
    const shoe = new THREE.Mesh(new THREE.CylinderGeometry(.9, .9, .35, 18), pad); shoe.position.set(0, .95, 4.0); g.add(shoe);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(.2, .2, 3.8, 10), mat); bar.rotation.z = Math.PI / 2; bar.position.set(0, 6.1, 4.0); g.add(bar);
    for (const sx of [-1.9, 1.9]) { const b = new THREE.Mesh(new THREE.SphereGeometry(.38, 12, 10), mat); b.position.set(sx, 6.1, 4.0); g.add(b); }
    g.traverse(o => { o.castShadow = true; });
    return g;
  }

  function driverBoard(mat) {
    // Waveshare serial-bus servo driver board mounted on the plate at the back of the base
    const g = new THREE.Group();
    const pcb = (w, h, d, color, x, y, z, o = {}) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, o)); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m;
    };
    pcb(4.2, 3.3, .16, 0x15803d, 0, 0, 0, { roughness: .45, clearcoat: .6 });          // green PCB
    pcb(1.9, 2.1, .3, 0xc9cdd3, .25, .2, .23, { roughness: .35, metalness: .8 });       // ESP32 shield can
    pcb(1.9, .45, .12, 0x0f1115, .25, 1.35, .17);                                       // antenna strip
    pcb(1.1, .55, .3, 0x0f1115, -1.2, -1.35, .23);                                      // power screw terminal
    pcb(1.1, .55, .3, 0x0f1115, .1, -1.35, .23);                                        // servo screw terminal
    pcb(.95, .38, .3, 0xd0d4da, -1.35, 1.45, .24, { roughness: .3, metalness: .8 });    // USB-C socket
    for (let i = 0; i < 3; i++) pcb(.62, .45, .32, 0xf4f4ee, 1.9, 1.0 - i * .85, .24);  // JST servo headers
    pcb(.22, .22, .18, 0xff3b30, -1.7, -.2, .17, { emissive: 0xff2010, emissiveIntensity: .6 }); // status LED
    return g;
  }

  function addMounting(arm, kind, ghost) {
    const root = arm.root, leader = kind === 'leader';
    arm.extras = [];
    const mat = (color, o = {}) => { const m = new THREE.MeshPhysicalMaterial({ color, roughness: .55, transparent: ghost, opacity: ghost ? .5 : 1, ...o }); arm.materials.push(m); return m; };
    const put = (o, x, y, z) => { o.position.set(x, y, z); o.traverse(c => { if (c.isMesh) c.receiveShadow = true; }); root.add(o); arm.extras.push(o); return o; };

    const slab = new THREE.Mesh(new THREE.BoxGeometry(24, 3, 28), mat(0xf1f2f4, { roughness: .85 }));   // table corner the arm is clamped to
    slab.castShadow = true; put(slab, 2, -1.5, 5.6 - 14);

    const red = mat(COLORS.clamp, { roughness: .3, metalness: .5, clearcoat: .6 }), pad = mat(0x23262d, { roughness: .8 });
    for (const x of leader ? [.4] : [-1.2, 5.4]) put(clampMesh(red, pad), x, 0, 0);      // leader: 1 clamp, follower: 2 (as photographed)

    const board = driverBoard(mat);
    board.rotation.y = -Math.PI / 2; put(board, -3.45, 4.9, .05);                         // bolted to the vertical plate on the -x side of the base

    const label = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.2),
      new THREE.MeshStandardMaterial({ map: markerLabel(leader ? ['L', 'ACM0'] : ['F', 'ACM1']), transparent: true, alphaTest: .04, roughness: .9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    label.rotation.y = Math.PI / 2; label.renderOrder = 3; put(label, 8.86, 3.5, -.1);                            // marker on the big flat face of the shoulder block
    arm.label = label; arm.materials.push(label.material);
  }
  /* ---------- URDF loading (own minimal parser: links, visuals, revolute joints) ---------- */
  const nums = s => (s || '0 0 0').trim().split(/\s+/).map(Number);
  const euler = rpy => new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX');   // URDF: R = Rz(y) Ry(p) Rx(r)
  const modelPromises = {};
  const geoCache = {};

  function loadModel(kind) {
    if (modelPromises[kind]) return modelPromises[kind];
    const loader = new THREE.STLLoader();
    const stl = file => geoCache[file] || (geoCache[file] = new Promise((res, rej) =>
      loader.load('/so101/meshes/' + file, g => res(g), undefined, rej)));
    modelPromises[kind] = fetch(URDF[kind]).then(r => r.text()).then(async txt => {
      const doc = new DOMParser().parseFromString(txt, 'application/xml');
      const links = {};
      for (const l of doc.querySelectorAll('robot > link')) {
        links[l.getAttribute('name')] = [...l.querySelectorAll(':scope > visual')].map(v => {
          const o = v.querySelector('origin');
          return {
            xyz: nums(o && o.getAttribute('xyz')), rpy: nums(o && o.getAttribute('rpy')),
            file: v.querySelector('mesh').getAttribute('filename').split('/').pop(),
            servo: (v.querySelector('material') || { getAttribute: () => '' }).getAttribute('name') === 'sts3215',
          };
        });
      }
      const joints = [...doc.querySelectorAll('robot > joint')].map(j => {
        const o = j.querySelector('origin');
        return {
          name: j.getAttribute('name'), parent: j.querySelector('parent').getAttribute('link'), child: j.querySelector('child').getAttribute('link'),
          xyz: nums(o.getAttribute('xyz')), rpy: nums(o.getAttribute('rpy')), axis: nums((j.querySelector('axis') || { getAttribute: () => '0 0 1' }).getAttribute('xyz')),
        };
      });
      const files = [...new Set(Object.values(links).flat().map(v => v.file))];
      await Promise.all(files.map(stl));
      for (const f of files) { geoCache[f] = await geoCache[f]; creasedNormals(geoCache[f]); }
      const children = new Set(joints.map(j => j.child));
      return { links, joints, root: Object.keys(links).find(n => !children.has(n)) };
    });
    return modelPromises[kind];
  }

  function makeMaterials(kind, ghost) {
    const mk = (color, o = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: .5, metalness: 0, clearcoat: .25, clearcoatRoughness: .55, transparent: ghost, opacity: ghost ? .5 : 1, depthWrite: !ghost, ...o });
    return {
      body: mk(COLORS[kind]),                                                                    // printed PLA
      servo: mk(0x0b0c0f, { roughness: .42, clearcoat: .4, clearcoatRoughness: .35, envMapIntensity: .5 }),       // glossy black servo case
    };
  }

  function instantiate(model, kind, ghost, arm) {
    const mats = makeMaterials(kind, ghost);
    arm.materials = Object.values(mats);
    const linkGroups = {};
    for (const [name, visuals] of Object.entries(model.links)) {
      const g = new THREE.Group(); g.name = name; linkGroups[name] = g;
      for (const v of visuals) {
        const m = new THREE.Mesh(geoCache[v.file], v.servo ? mats.servo : mats.body);
        m.position.set(...v.xyz); m.rotation.copy(euler(v.rpy));
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
    }
    arm.links = linkGroups; arm.joints = {}; arm.rootName = model.root;
    for (const j of model.joints) {
      const origin = new THREE.Group(); origin.position.set(...j.xyz); origin.rotation.copy(euler(j.rpy));
      const rot = new THREE.Group();
      origin.add(rot); rot.add(linkGroups[j.child]); linkGroups[j.parent].add(origin);
      arm.joints[j.name] = { rot, axis: new THREE.Vector3(...j.axis) };
    }
    // robot is Z-up in metres -> Y-up in centimetres
    arm.model.add(linkGroups[model.root]);
    arm.model.rotation.x = -Math.PI / 2; arm.model.scale.setScalar(100);
    arm.model.position.y = .2;                    // lift so the foot of the base rests exactly on the table
    arm.ready = true;
    buildCables(arm, model);
    applyPose(arm, arm.cur);
  }


  // The leader and follower URDFs come from different CAD exports and some joints are mirrored (the same reading turns
  // them in opposite directions). Rotate each joint by a test angle on both arms, compare where the hand moves in each
  // arm's own frame (forward / up / right), and flip the leader's sign wherever the two disagree.
  function alignLeaderToFollower() {
    const L = arms.leader, F = arms.follower;
    if (!L.ready || !F.ready || L.aligned) return;
    const probe = new THREE.Vector3(0, 0, -.06), off = new THREE.Vector3(.04, 0, 0);
    const handOf = arm => arm.joints[JOINTS[arm.kind].wroll].rot.children[0];
    const base = arm => arm.links[arm.rootName];
    const measure = (arm, key, angle) => {
      const zero = { pan: 0, lift: 0, elbow: 0, wflex: 0, wroll: 0, grip: 0 };
      const at = c => { applyPose(arm, c); arm.root.updateMatrixWorld(true); return handOf(arm).localToWorld((key === 'wroll' ? off : probe).clone()); };
      const p0 = at(zero), p1 = at({ ...zero, [key]: angle });
      const b = base(arm).getWorldPosition(new THREE.Vector3());
      const fwd = p0.clone().sub(b); fwd.y = 0; fwd.normalize();
      const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3().crossVectors(fwd, up);
      const d = p1.sub(p0); return new THREE.Vector3(d.dot(fwd), d.dot(up), d.dot(right));
    };
    const report = {};
    for (const k of ['pan', 'lift', 'elbow', 'wflex', 'wroll']) {
      const dl = measure(L, k, .5), df = measure(F, k, .5);
      const cos = dl.dot(df) / ((dl.length() * df.length()) || 1);
      signFix.leader[k] = cos < 0 ? -1 : 1; report[k] = +cos.toFixed(2);
    }
    L.aligned = true; applyPose(L, L.cur); applyPose(F, F.cur);
    if (window.console) console.info('3D: leader/follower direction match per joint (cos; negative = flipped)', report, signFix.leader);
  }


  // The two CAD files place and orient their bases differently (the follower's arm points +z, the leader's +x, and
  // their base origins differ). Turn the follower by 90 deg about the vertical and shift it so its shoulder-pan joint
  // lands exactly where the leader's does; both arms then share one frame, so the base, clamps, board and labels line up.
  function finishSetup() {
    const L = arms.leader, F = arms.follower;
    if (!L.ready || !F.ready || arms.done) return;
    const panPos = arm => { arm.root.updateMatrixWorld(true); return arm.root.worldToLocal(arm.joints[JOINTS[arm.kind].pan].rot.getWorldPosition(new THREE.Vector3())); };
    for (const a of [L, F]) for (const k of Object.keys(JOINTS.follower)) { const j = a.joints[JOINTS[a.kind][k]]; if (j) j.rot.quaternion.identity(); }
    const pL = panPos(L), pF = panPos(F);
    F.align.rotation.y = Math.PI / 2;
    F.align.position.set(pL.x - pF.z, pL.y - pF.y, pL.z + pF.x);          // pL - R * pF, with R = Ry(+90 deg)
    // markers sit on the shoulder block, so they must turn with the pan joint
    for (const a of [L, F]) if (a.label) { a.root.updateMatrixWorld(true); a.joints[JOINTS[a.kind].pan].rot.children[0].attach(a.label); }
    arms.done = true;
    alignLeaderToFollower();
  }
  function applyPose(a, c) {
    if (!a.ready) return;
    for (const k of Object.keys(JOINTS.follower)) {
      const j = a.joints[JOINTS[a.kind][k]]; if (j) j.rot.quaternion.setFromAxisAngle(j.axis, c[k]);
    }
  }
  function apply(a, p, k) {
    for (const key in p) a.cur[key] += (p[key] - a.cur[key]) * k;
    applyPose(a, a.cur);
  }

  function buildArm(kind, ghost) {
    const arm = { root: new THREE.Group(), model: new THREE.Group(), align: new THREE.Group(), ready: false, cur: { ...ZERO }, materials: [], kind };
    arm.root.add(arm.align); arm.align.add(arm.model);
    arm.root.rotation.y = -Math.PI / 2;           // the leader's CAD frame faces +x; turn both arms to face the camera (+z)
    addMounting(arm, kind, ghost);
    loadModel(kind).then(m => { if (arms && arms[kind] === arm) { instantiate(m, kind, ghost, arm); finishSetup(); setMode(opts.mode); } })
      .catch(e => { console.error('SO-101 model failed to load', e); if (host) host.insertAdjacentHTML('beforeend', '<div class="empty3d">Could not load the SO-101 model files.</div>'); });
    return arm;
  }

  function demo(t) {
    const s = Math.sin;
    return { pan: s(t * .7) * .8, lift: s(t * .5) * .6, elbow: .6 + s(t * .6 + 1) * .6, wflex: s(t * .9) * .6, wroll: s(t * .4) * 1.2, grip: .5 + (s(t * 1.3) + 1) * .5 };
  }

  function resize() {
    if (!host || !renderer) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !host || !host.offsetParent) return;
    if (!t0) t0 = now;
    const fresh = performance.now() - lastData < 600;
    if (fresh) {
      apply(arms.leader, target.leader || ZERO, .35); apply(arms.follower, target.follower || ZERO, .35);
    } else if (opts.demo && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const t = (now - t0) / 1000;
      apply(arms.leader, demo(t), .12); apply(arms.follower, demo(t - .35), .12);
    } else { apply(arms.leader, ZERO, .1); apply(arms.follower, ZERO, .1); }
    updateCables(arms.leader); updateCables(arms.follower);
    controls && controls.update();
    renderer.render(scene, camera);
  }

  function setMode(mode = 'split') {
    opts.mode = mode;
    if (!arms) return;
    const overlay = mode === 'overlay';
    arms.leader.root.position.x = overlay ? 0 : -SPLIT_X;
    arms.follower.root.position.x = overlay ? 0 : SPLIT_X;
    arms.leader.materials.forEach(m => { m.transparent = overlay; m.opacity = overlay ? .5 : 1; m.depthWrite = !overlay; m.needsUpdate = true; });
    arms.leader.extras && arms.leader.extras.forEach(o => { o.visible = !overlay; });
    setCameraPreset('iso');
  }

  function setCameraPreset(preset = 'iso') {
    if (!camera) return;
    const fx = opts.mode === 'split' ? SPLIT_X : 0;
    const P = {
      iso: [[58, 38, 78], [0, 17, 0]],
      front: [[0, 24, 132], [0, 17, 0]],
      top: [[0, 118, 1], [0, 6, 0]],
      follower: [[fx + 40, 32, 66], [fx, 17, 0]],
      leader: [[-fx - 40, 32, 66], [-fx, 17, 0]],
      leaderBase: [[-fx + 6, 7, 34], [-fx, 4.3, 8.8]],
      followerBase: [[fx + 6, 7, 34], [fx, 4.3, 8.8]],
      backBase: [[fx + 6, 8, -30], [fx, 5, -3.4]],
    }[preset];
    if (!P) return;
    camera.position.set(...P[0]);
    if (controls) { controls.target.set(...P[1]); controls.update(); } else camera.lookAt(...P[1]);
  }

  function mount(el, o = {}) {
    unmount();
    host = el; opts = { ...opts, ...o };
    if (!available()) { el.innerHTML = '<div class="empty3d">3D view unavailable (could not load Three.js — check network connection).</div>'; return false; }
    const canvas = document.createElement('canvas'); canvas.style.touchAction = 'none';
    el.appendChild(canvas);
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
    catch { el.innerHTML = '<div class="empty3d">3D view unavailable (WebGL is disabled in this browser).</div>'; return false; }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .85;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, .5, 600);
    scene.environment = studioEnvironment(renderer);

    const key = new THREE.DirectionalLight(0xfff6ea, .9); key.position.set(40, 90, 55);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -.0004; key.shadow.normalBias = .15;
    Object.assign(key.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 10, far: 260 });
    scene.add(key);

    // seamless white studio floor: only the shadows are drawn on it
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: .22 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

    arms = {};
    arms.leader = buildArm('leader', opts.mode === 'overlay');
    arms.follower = buildArm('follower', false);
    scene.add(arms.leader.root, arms.follower.root);

    if (THREE.OrbitControls) {
      controls = new THREE.OrbitControls(camera, canvas);
      controls.enableDamping = true; controls.dampingFactor = .08;
      controls.maxPolarAngle = Math.PI * .49; controls.minDistance = 20; controls.maxDistance = 220;
    }
    setMode(opts.mode);
    ro = new ResizeObserver(resize); ro.observe(el); resize();
    t0 = 0; raf = requestAnimationFrame(frame);
    return true;
  }

  function unmount() {
    cancelAnimationFrame(raf); ro && ro.disconnect();
    if (renderer) { renderer.dispose(); renderer = null; }
    // geometries are shared through geoCache and stay alive; only materials are per-mount
    scene && scene.traverse(o => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; ms.forEach(m => m.dispose()); });
    scene = controls = ro = arms = host = camera = null;
  }

  function update(leader, follower) {
    if (!leader || !Object.keys(leader).length) return;
    target.leader = pose(leader, 'leader');
    target.follower = pose(follower && Object.keys(follower).length ? follower : leader);
    lastData = performance.now();
  }
  const resetView = () => setCameraPreset('iso');
  const setDemo = on => { opts.demo = on; };
  const getMode = () => opts.mode;

  return { mount, unmount, update, resetView, setDemo, setMode, setCameraPreset, getMode, available, TUNE, debug: () => ({ scene, arms, camera }) };
})();
