// main.js — boot and the one loop: a fixed 60 Hz simulation feeding a render
// at the display's rate. Rounds, the bomb, tracers, smoke and the HUD all hang
// off the single store in state.js; nothing here allocates in the hot loop
// (tracers and smoke puffs come from pre-allocated pools).
//
// ?shot=start|play|end with &seed=N renders one deterministic frame for a
// capture, then freezes and sets window.__shotReady. window.__debug exposes
// the same code paths the player uses, so an automated play-test can drive a
// full round without a mouse.

import * as THREE from 'three';
import { createState, WEAPONS, ROUND, awardMoney, buyWeapon, buySmoke } from './state.js';
import { createWorld, MAP, segmentBlocked } from './world.js';
import { createPlayer } from './player.js';
import { createWeaponState, tryFire, startReload, stepWeapon, currentSpread, createViewmodel } from './weapons.js';
import { createBots, resetBots, updateBots, killBot } from './bots.js';
import { createHud } from './hud.js';
import { sfx, ensureAudio } from './audio.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '7', 10) || 7;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

const state = createState();
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87a8c8);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
camera.rotation.order = 'YXZ';
scene.add(camera);

const world = createWorld(scene);
const bots = createBots(scene, state);
const player = createPlayer(world.colliders);
const body = player.body;
const viewmodel = createViewmodel(camera);
let weapon = createWeaponState(state.loadout);
viewmodel.setWeapon(weapon.def.id);

const hud = createHud({
  onPlay: () => { ensureAudio(); if (state.phase === 'menu') startMatch(); else if (state.phase === 'end') nextRound(); input.requestLock(); },
  onBuy: (id) => { if (buyWeapon(state, id)) { weapon = createWeaponState(state.loadout); viewmodel.setWeapon(id); hud.renderBuy(state.money, state.loadout); hud.setMoney(state.money); hud.setWeapon(weapon.def.name); hud.setAmmo(weapon.mag, weapon.reserve, false); sfx.buy(); } },
  onBuySmoke: () => { if (buySmoke(state)) { hud.renderBuy(state.money, state.loadout); hud.setMoney(state.money); hud.setSmoke(state.loadout.smoke); sfx.buy(); } },
  onCloseBuy: () => { hud.showBuy(false); input.requestLock(); },
});

const input = createInput(renderer.domElement);
const raycaster = new THREE.Raycaster();
raycaster.far = 100;
const shootDir = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

// --- Tracer pool: 12 reusable lines, no per-frame allocation. ---
const tracers = [];
for (let i = 0; i < 12; i += 1) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0 }));
  line.frustumCulled = false;
  scene.add(line);
  tracers.push({ line, ttl: 0 });
}
let tracerIdx = 0;
function spawnTracer(from, to, colour) {
  const t = tracers[tracerIdx];
  tracerIdx = (tracerIdx + 1) % tracers.length;
  const pos = t.line.geometry.attributes.position;
  pos.setXYZ(0, from.x, from.y, from.z);
  pos.setXYZ(1, to.x, to.y, to.z);
  pos.needsUpdate = true;
  t.line.material.color.setHex(colour);
  t.line.material.opacity = 0.9;
  t.ttl = 0.12;
}

// --- Smoke pool: 4 reusable puffs. ---
const smokes = [];
for (let i = 0; i < 4; i += 1) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xcfd4d6, transparent: true, opacity: 0, roughness: 1 }),
  );
  mesh.visible = false;
  scene.add(mesh);
  smokes.push({ mesh, x: 0, z: 0, radius: 0, ttl: 0, active: false });
}
let smokeIdx = 0;
function throwSmoke() {
  if (state.loadout.smoke <= 0 || state.phase !== 'live') return;
  state.loadout.smoke -= 1;
  hud.setSmoke(state.loadout.smoke);
  camera.getWorldDirection(shootDir);
  const s = smokes[smokeIdx];
  smokeIdx = (smokeIdx + 1) % smokes.length;
  s.x = body.position.x + shootDir.x * 7;
  s.z = body.position.z + shootDir.z * 7;
  s.radius = 4.5;
  s.ttl = 10;
  s.active = true;
  s.mesh.visible = true;
  s.mesh.position.set(s.x, 1.4, s.z);
  s.mesh.scale.setScalar(s.radius);
  s.mesh.material.opacity = 0.75;
  state.smokes.push({ x: s.x, z: s.z, radius: s.radius, ttl: s.ttl });
  sfx.smoke();
}

// --- Input: keys + pointer lock + mouse look. ---
function createInput(canvas) {
  const keys = new Set();
  let lookX = 0, lookY = 0, firing = false, locked = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.preventDefault();
    keys.add(e.code);
    if (e.code === 'KeyB' && (state.phase === 'buy' || state.phase === 'live')) {
      const open = document.getElementById('buy').hidden;
      hud.showBuy(open, state.money, state.loadout);
      if (open && document.pointerLockElement) document.exitPointerLock();
      if (!open) canvas.requestPointerLock();
    }
    if (e.code === 'KeyG') throwSmoke();
    if (e.code === 'KeyR') { if (startReload(weapon)) sfx.reload(); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('mousedown', (e) => { if (locked && e.button === 0) firing = true; });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    lookX += e.movementX; lookY += e.movementY;
  });
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (!locked && state.phase !== 'menu' && !shot) {
      const buyOpen = !document.getElementById('buy').hidden;
      if (!buyOpen && state.phase === 'live') hud.showOverlay('paused');
    }
  });
  return {
    state: { keys, get firing() { return firing; } },
    takeLook() { const l = { x: lookX, y: lookY }; lookX = 0; lookY = 0; return l; },
    requestLock() { canvas.requestPointerLock(); },
    get locked() { return locked; },
  };
}

// --- Shooting: hitscan against bot bodies (head = head mesh). ---
// No friendly fire: only Ember bots are shootable targets.
function botHitMeshes() {
  const out = [];
  for (const b of bots) {
    if (!b.alive || b.team !== 'ember') continue;
    out.push(b.mesh.userData.body, b.mesh.userData.head);
  }
  return out;
}

function shoot() {
  const res = tryFire(weapon, performance.now() / 1000, body.speed2d, body.crouched);
  if (res.dry) { sfx.dry(); return; }
  if (!res.fired) return;
  camera.getWorldDirection(shootDir);
  shootDir.x += (random() * 2 - 1) * res.spread;
  shootDir.y += (random() * 2 - 1) * res.spread;
  shootDir.z += (random() * 2 - 1) * res.spread;
  shootDir.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, shootDir);
  const hits = raycaster.intersectObjects(botHitMeshes(), false);
  const end = tmpV.copy(camera.position).addScaledVector(shootDir, weapon.def.range);
  let hitPoint = end;
  if (hits.length) {
    const hit = hits[0];
    hitPoint = hit.point;
    const bot = hit.object.parent.userData.bot;
    const isHead = hit.object === bot.mesh.userData.head;
    const dmg = Math.round(weapon.def.damage * (isHead ? weapon.def.headMult : 1));
    damageBot(bot, dmg, null, isHead);
    hud.hitMarker(bot.hp <= 0);
    sfx.hit();
    if (bot.hp <= 0) sfx.kill();
  }
  spawnTracer(camera.position, hitPoint, weapon.def.tracer);
  if (weapon.def.id === 'marksman') sfx.shootMarksman(); else sfx.shoot();
  player.applyRecoil(weapon.def.recoil, (random() * 2 - 1) * weapon.def.recoil * 0.4);
  viewmodel.kick(weapon.def.recoil * 2.2);
  hud.setAmmo(weapon.mag, weapon.reserve, weapon.reloading);
}

function damageBot(bot, dmg, attacker, isHead) {
  if (!bot.alive) return;
  bot.hp -= dmg;
  if (bot.hp <= 0) {
    killBot(bot);
    state.kills += 1;
    awardMoney(state, ROUND.KILL_REWARD, 'kill');
    hud.setMoney(state.money);
    hud.feed(`YOU ${isHead ? '⌖ headshot ' : ''}▸ ${bot.name} (${bot.team})`);
    if (state.bomb.carrier === bot && state.bomb.status === 'carried') {
      state.bomb.status = 'dropped';
      state.bomb.x = bot.pos.x; state.bomb.z = bot.pos.z;
      hud.setBomb('BOMB DROPPED — carrier down', 'warn');
      hud.banner('BOMB CARRIER DOWN', 'The bomb lies where they fell.');
    }
    checkRoundEnd();
  }
}

function damagePlayer(dmg, fromBot) {
  if (!body.alive || state.phase !== 'live') return;
  body.hp -= dmg;
  hud.setHp(body.hp);
  hud.damageFlash();
  sfx.hurt();
  if (body.hp <= 0) {
    body.alive = false;
    state.deaths += 1;
    hud.feed(`${fromBot ? fromBot.name : 'Ember'} ▸ YOU`);
    hud.banner('YOU ARE DOWN', 'Your team fights on without you.', 2000);
    checkRoundEnd();
  }
}

// --- Round flow. ---
function aliveCount(team) {
  let n = team === 'vanguard' && body.alive ? 1 : 0;
  for (const b of bots) if (b.alive && b.team === team) n += 1;
  return n;
}

function startMatch() {
  state.score.vanguard = 0; state.score.ember = 0;
  state.round = 1; state.money = 800; state.kills = 0; state.deaths = 0;
  state.loadout = { primary: 'sidearm', secondary: 'sidearm', smoke: 1 };
  weapon = createWeaponState(state.loadout);
  viewmodel.setWeapon(weapon.def.id);
  hud.hideOverlay();
  hud.setMoney(state.money);
  hud.setWeapon(weapon.def.name);
  hud.setSmoke(state.loadout.smoke);
  startRound();
}

function startRound() {
  resetBots(bots, state);
  state.bomb.status = 'carried';
  state.bomb.timer = 0; state.bomb.progress = 0;
  state.smokes.length = 0;
  for (const s of smokes) { s.active = false; s.mesh.visible = false; }
  const spawn = MAP.vanguardSpawn[0];
  player.resetSpawn(spawn.x, spawn.z, Math.PI);
  weapon = createWeaponState(state.loadout);
  hud.setHp(body.hp);
  hud.setAmmo(weapon.mag, weapon.reserve, false);
  hud.setWeapon(weapon.def.name);
  hud.setScore(state.score.vanguard, state.score.ember, state.round);
  hud.setAlive(aliveCount('vanguard'), aliveCount('ember'));
  hud.setBomb('BOMB WITH EMBER — defend both sites', '');
  hud.setPrompt('BUY PHASE — press B to open the shop');
  state.phase = 'buy';
  state.phaseTime = ROUND.BUY_SECONDS;
  sfx.roundStart();
  hud.banner(`ROUND ${state.round}`, 'Buy phase — press B for weapons. Defend sites A and B.');
}

function nextRound() {
  if (state.score.vanguard >= 5 || state.score.ember >= 5) {
    state.phase = 'menu';
    hud.showOverlay('match', { v: state.score.vanguard, e: state.score.ember });
    return;
  }
  state.round += 1;
  startRound();
}

function endRound(winner, reason) {
  if (state.phase !== 'live' && state.phase !== 'buy') return;
  state.phase = 'end';
  state.phaseTime = ROUND.END_SECONDS;
  state.roundWinner = winner;
  state.roundReason = reason;
  if (winner === 'vanguard') {
    state.score.vanguard += 1;
    awardMoney(state, ROUND.WIN_ROUND, 'round win');
    sfx.roundWin();
  } else {
    state.score.ember += 1;
    awardMoney(state, ROUND.LOSE_ROUND, 'round loss');
    sfx.roundLose();
  }
  hud.setScore(state.score.vanguard, state.score.ember, state.round);
  hud.setMoney(state.money);
  hud.setPrompt('');
  hud.setBomb('', '');
  hud.banner(winner === 'vanguard' ? 'ROUND WON' : 'ROUND LOST', reason, 3600);
  if (document.pointerLockElement) document.exitPointerLock();
  if (state.phase === 'end') hud.showOverlay('round', { won: winner === 'vanguard', reason, v: state.score.vanguard, e: state.score.ember });
}

function checkRoundEnd() {
  if (state.phase !== 'live') return;
  const v = aliveCount('vanguard'), e = aliveCount('ember');
  hud.setAlive(v, e);
  // With the bomb planted, wiping the attackers does NOT end the round:
  // the bomb still has to be defused (or it detonates).
  if (state.bomb.status === 'planted') {
    if (v === 0) endRound('ember', 'Vanguard team eliminated — the bomb detonates.');
    return;
  }
  if (e === 0) endRound('vanguard', 'Ember team eliminated.');
  else if (v === 0) endRound('ember', 'Vanguard team eliminated.');
}

// Bomb events from bots.js.
const botCtx = {
  colliders: world.colliders,
  smokes: state.smokes,
  bots,
  state,
  random,
  get playerPos() { return body.position; },
  get playerAlive() { return body.alive && state.phase === 'live'; },
  get playerCrouched() { return body.crouched; },
  get playerSpeed() { return body.speed2d; },
  damagePlayer,
  damageBot: (bot, dmg) => damageBot(bot, dmg, null, false),
  tracer: (from, to, hit) => spawnTracer(from, to, hit ? 0xff6b5e : 0xffd24d),
  noise: () => {},
  onPlant: (bot) => {
    state.bomb.status = 'planted';
    state.bomb.x = bot.pos.x; state.bomb.z = bot.pos.z;
    state.bomb.timer = ROUND.BOMB_SECONDS;
    state.bomb.site = Math.hypot(MAP.siteA.x - bot.pos.x, MAP.siteA.z - bot.pos.z) < Math.hypot(MAP.siteB.x - bot.pos.x, MAP.siteB.z - bot.pos.z) ? MAP.siteA : MAP.siteB;
    awardMoney(state, ROUND.PLANT_REWARD, 'plant');
    hud.setBomb('BOMB PLANTED — defuse it! (hold E)', 'danger');
    hud.banner('BOMB PLANTED', 'Hold E at the bomb to defuse.', 3200);
    sfx.plantBeep();
  },
  onDefuse: () => {
    state.bomb.status = 'defused';
    state.defuses += 1;
    endRound('vanguard', 'Bomb defused.');
  },
};

// Player defuse: hold E near the planted bomb.
let defuseHeld = 0;
function updateDefuse(dt) {
  if (state.bomb.status !== 'planted' || !body.alive) { defuseHeld = 0; return; }
  const d = Math.hypot(state.bomb.x - body.position.x, state.bomb.z - body.position.z);
  if (d < 2.2 && input.state.keys.has('KeyE')) {
    defuseHeld += dt;
    hud.setPrompt(`DEFUSING… ${Math.ceil(ROUND.DEFUSE_SECONDS - defuseHeld)}s — hold E`);
    if (Math.floor(defuseHeld * 2) !== Math.floor((defuseHeld - dt) * 2)) sfx.plantBeep();
    if (defuseHeld >= ROUND.DEFUSE_SECONDS) {
      state.bomb.status = 'defused';
      state.defuses += 1;
      endRound('vanguard', 'Bomb defused by YOU.');
    }
  } else {
    defuseHeld = 0;
    if (d < 2.2) hud.setPrompt('Hold E to defuse the bomb');
  }
}

// --- Simulation step (fixed 60 Hz). ---
let elapsed = 0;
let lastBombTick = -1;
function step(dt) {
  elapsed += dt;
  if (state.phase === 'buy') {
    state.phaseTime -= dt;
    if (state.phaseTime <= 0) {
      state.phase = 'live';
      state.phaseTime = ROUND.LIVE_SECONDS;
      hud.setPrompt('');
      hud.showBuy(false);
      hud.banner('GO — ROUND LIVE', 'Eliminate Ember or stop the bomb.', 1800);
    }
  } else if (state.phase === 'live') {
    state.phaseTime -= dt;
    if (state.bomb.status === 'planted') {
      state.bomb.timer -= dt;
      const tick = Math.ceil(state.bomb.timer);
      if (tick !== lastBombTick) { lastBombTick = tick; if (tick <= 10) sfx.bombTick(); }
      hud.setBomb(`BOMB PLANTED — ${tick}s to detonation`, 'danger');
      if (state.bomb.timer <= 0) {
        state.bomb.status = 'exploded';
        sfx.explode();
        endRound('ember', 'The bomb detonated.');
      }
    }
    if (state.phaseTime <= 0 && state.phase === 'live') {
      endRound('vanguard', 'Time expired — sites held.');
    }
  } else if (state.phase === 'end') {
    state.phaseTime -= dt;
    if (state.phaseTime <= 0) nextRound();
  }

  // Buy phase: the player may walk the spawn, but bots hold position and
  // nobody fights until the round goes live.
  if (state.phase === 'buy') {
    player.step(dt, input.state.keys);
  } else if (state.phase === 'live') {
    player.step(dt, input.state.keys);
    updateBots(bots, dt, botCtx);
    updateDefuse(dt);
  }
  stepWeapon(weapon, dt);
  if (weapon.reloading && weapon.reloadT <= 0) hud.setAmmo(weapon.mag, weapon.reserve, false);

  // Smoke clouds age and shrink.
  for (const s of smokes) {
    if (!s.active) continue;
    s.ttl -= dt;
    if (s.ttl <= 0) {
      s.active = false; s.mesh.visible = false;
      const i = state.smokes.findIndex((c) => c.x === s.x && c.z === s.z);
      if (i >= 0) state.smokes.splice(i, 1);
    } else {
      s.mesh.material.opacity = Math.min(0.75, s.ttl * 0.2);
    }
  }
  for (const t of tracers) {
    if (t.ttl > 0) {
      t.ttl -= dt;
      t.line.material.opacity = Math.max(0, t.ttl / 0.12) * 0.9;
    }
  }
  viewmodel.step(dt, body.speed2d > 0.5);
  hud.setTimer(state.phase === 'buy' || state.phase === 'live' ? state.phaseTime : 0, state.phase);
  if (state.phase === 'live' || state.phase === 'buy') hud.setAlive(aliveCount('vanguard'), aliveCount('ember'));
}

function syncCamera() {
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(body.pitch + body.recoilPitch, body.yaw + body.recoilYaw, 0);
}

// --- Frame loop: fixed-step sim, render at display rate. ---
let accumulator = 0;
let lastTime = performance.now();
let frozen = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    if (input.state.firing && state.phase === 'live' && body.alive) shoot();
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function settle(steps) {
  for (let i = 0; i < steps; i += 1) step(FIXED_STEP);
}

// --- Screenshot modes: deterministic frames, then freeze. ---
function runShot(name) {
  hud.hideOverlay();
  if (name === 'start') {
    body.position.x = 0.6; body.position.y = 0; body.position.z = 8.6;
    body.yaw = 0.15; body.pitch = 0;
    settle(20);
    hud.showOverlay('start');
    syncCamera();
  } else if (name === 'play') {
    startMatch();
    state.phase = 'live';
    state.phaseTime = 60;
    // Pull two Ember bots into the mid lane in front of the player.
    const e1 = bots.find((b) => b.team === 'ember');
    const e2 = bots.find((b) => b.team === 'ember' && b !== e1);
    e1.pos.x = -2; e1.pos.z = 2; e2.pos.x = 3; e2.pos.z = -2;
    body.position.x = 0; body.position.y = 0; body.position.z = 10;
    body.yaw = 0; body.pitch = 0;
    settle(30);
    // Aim at the nearest bot and fire twice so the frame shows a tracer.
    const target = e1;
    const dx = target.pos.x - body.position.x;
    const dy = 1.2 - (body.position.y + body.eye);
    const dz = target.pos.z - body.position.z;
    body.yaw = Math.atan2(-dx, -dz);
    body.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
    syncCamera();
    shoot(); settle(2); shoot();
    hud.setAmmo(weapon.mag, weapon.reserve, false);
    hud.setHp(body.hp);
  } else { // 'end'
    startMatch();
    state.score.vanguard = 3; state.score.ember = 2;
    endRound('vanguard', 'Ember team eliminated.');
    settle(10);
    body.position.x = -4; body.position.y = 0; body.position.z = 12;
    body.yaw = 0.4; body.pitch = -0.02;
  }
  syncCamera();
  let painted = 0;
  (function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) { window.__shotReady = true; frozen = true; }
  }());
}

// Debug hooks for automated play-testing: same code paths as real play.
window.__debug = {
  state, player: body, bots,
  startMatch, endRound, nextRound,
  press(key, down) { if (down) input.state.keys.add(key); else input.state.keys.delete(key); },
  fire() { shoot(); },
  aimAtBot() {
    const alive = bots.filter((b) => b.alive && b.team === 'ember');
    if (!alive.length) return false;
    let best = alive[0], bd = Infinity;
    for (const b of alive) {
      const d = (b.pos.x - body.position.x) ** 2 + (b.pos.z - body.position.z) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    const dx = best.pos.x - body.position.x;
    const dy = 1.2 - (body.position.y + body.eye);
    const dz = best.pos.z - body.position.z;
    body.yaw = Math.atan2(-dx, -dz);
    body.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
    syncCamera();
    return true;
  },
  teleport(x, z) { body.position.x = x; body.position.z = z; },
  plantNow() { botCtx.onPlant(bots.find((b) => b.team === 'ember')); },
  mag() { return { mag: weapon.mag, reserve: weapon.reserve, reloading: weapon.reloading }; },
  heal() { body.hp = 100; body.alive = true; },
  reload() { startReload(weapon); },
  buy(id) { return buyWeapon(state, id); },
  smoke() { throwSmoke(); },
  aliveCounts() { return { v: aliveCount('vanguard'), e: aliveCount('ember') }; },
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

syncCamera();
hud.setHp(100);
hud.setAmmo(weapon.mag, weapon.reserve, false);
hud.setWeapon(weapon.def.name);
hud.setMoney(state.money);
hud.setScore(0, 0, 1);
hud.setAlive(5, 5);
hud.setSmoke(state.loadout.smoke);
hud.setBomb('', '');
if (shot) runShot(shot);
else {
  hud.showOverlay('start');
  requestAnimationFrame(frame);
}
