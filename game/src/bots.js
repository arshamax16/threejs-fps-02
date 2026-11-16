// bots.js — the nine bots: 4 Vanguard teammates (teal) and 5 Ember attackers
// (amber). One module owns their bodies, their route-following and their
// shooting, so main.js only asks "what happened this step".
//
// AI in three layers, cheapest first:
//  1. Route: BFS over world.js waypoints toward a goal node (a bombsite for
//     the Ember carrier, a hold node for everyone else).
//  2. React: if an enemy is visible (line of sight, in front, not smoked),
//     stop and shoot in bursts; accuracy falls with distance and target speed.
//  3. Objective: the carrier plants at a site; Vanguard bots defuse a planted
//     bomb. Bots hear gunfire: a shot within 25 m pulls nearby bots toward it.

import * as THREE from 'three';
import { MAP, segmentBlocked, resolveCircle } from './world.js';
import { WEAPONS } from './state.js';

const NAMES_V = ['Rook', 'Iris', 'Boone', 'Sable'];
const NAMES_E = ['Vex', 'Koda', 'Mira', 'Ash', 'Rune'];
const TEAM_COLOUR = { vanguard: 0x2e8f8a, ember: 0xc65a2e };
const BOT_SPEED = 3.4;
const SIGHT_RANGE = 42;

function bfsPath(graph, from, to) {
  if (from === to) return [to];
  const prev = new Array(graph.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length) {
    const n = queue.shift();
    for (const link of graph[n].links) {
      if (prev[link] === -1) {
        prev[link] = n;
        if (link === to) {
          const path = [to];
          let cur = to;
          while (cur !== from) { cur = prev[cur]; path.unshift(cur); }
          return path;
        }
        queue.push(link);
      }
    }
  }
  return [to];
}

function makeBotMesh(scene, team) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: TEAM_COLOUR[team], roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23211e, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.95, 0.32), mat);
  body.position.y = 0.95;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), dark);
  head.position.y = 1.62;
  head.castShadow = true;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.05),
    new THREE.MeshStandardMaterial({ color: team === 'vanguard' ? 0x7fe0d4 : 0xffb36b, emissive: team === 'vanguard' ? 0x2e8f8a : 0xc65a2e, emissiveIntensity: 0.7 }));
  visor.position.set(0, 1.64, 0.18);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.7), dark);
  gun.position.set(0.2, 1.15, 0.25);
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.22, 4),
    new THREE.MeshBasicMaterial({ color: TEAM_COLOUR[team] }));
  marker.position.y = 2.05;
  marker.rotation.x = Math.PI;
  group.add(body, head, visor, gun, marker);
  group.userData.body = body;
  group.userData.head = head;
  scene.add(group);
  return group;
}

export function createBots(scene, state) {
  const bots = [];
  const mk = (team, name, i, spawn) => {
    const mesh = makeBotMesh(scene, team);
    mesh.position.set(spawn.x, 0, spawn.z);
    const bot = {
      id: `${team}-${i}`, team, name,
      hp: 100, alive: true,
      pos: { x: spawn.x, z: spawn.z },
      yaw: team === 'vanguard' ? Math.PI : 0,
      node: team === 'vanguard' ? 0 : 10,
      path: [], pathIdx: 0,
      goalNode: team === 'vanguard' ? 2 : 8,
      holdT: 0, state: 'advance',
      shootT: 0, burstLeft: 0, burstPause: 0,
      weapon: team === 'vanguard' ? WEAPONS.rifle : WEAPONS.smg,
      plantT: 0, defuseT: 0,
      mesh, dead: false,
    };
    bot.mesh.userData.bot = bot;
    bots.push(bot);
    return bot;
  };
  MAP.vanguardSpawn.forEach((s, i) => { if (i < 4) mk('vanguard', NAMES_V[i], i, s); });
  MAP.emberSpawn.forEach((s, i) => mk('ember', NAMES_E[i], i, s));
  state.bots = bots;
  return bots;
}

export function resetBots(bots, state) {
  const vSpawns = MAP.vanguardSpawn, eSpawns = MAP.emberSpawn;
  let vi = 0, ei = 0;
  for (const bot of bots) {
    const spawn = bot.team === 'vanguard' ? vSpawns[vi++] : eSpawns[ei++];
    bot.hp = 100; bot.alive = true; bot.dead = false;
    bot.pos.x = spawn.x; bot.pos.z = spawn.z;
    bot.yaw = bot.team === 'vanguard' ? Math.PI : 0;
    bot.node = bot.team === 'vanguard' ? 0 : 10;
    bot.path = []; bot.pathIdx = 0;
    bot.goalNode = bot.team === 'vanguard' ? 2 : 8;
    bot.holdT = 0; bot.state = 'advance';
    bot.shootT = 0; bot.burstLeft = 0; bot.burstPause = 0;
    bot.plantT = 0; bot.defuseT = 0;
    bot.mesh.rotation.set(0, bot.yaw, 0);
    bot.mesh.position.set(spawn.x, 0, spawn.z);
    bot.mesh.visible = true;
  }
  // The Ember carrier is the first attacker; he picks a random site each round.
  const carrier = bots.find((b) => b.team === 'ember');
  state.bomb.carrier = carrier;
  state.bomb.site = Math.random() < 0.5 ? MAP.siteA : MAP.siteB;
  carrier.goalNode = state.bomb.site === MAP.siteA ? 8 : 9;
  carrier.path = bfsPath(MAP.waypoints, carrier.node, carrier.goalNode);
  carrier.pathIdx = 0;
}

// Nearest waypoint index to a point.
function nearestNode(x, z) {
  let best = 0, bd = Infinity;
  MAP.waypoints.forEach((w, i) => {
    const d = (w.x - x) ** 2 + (w.z - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

export function updateBots(bots, dt, ctx) {
  // ctx: { colliders, smokes, playerPos, playerAlive, playerCrouched,
  //        playerSpeed, damagePlayer, damageBot, onPlant, onDefuse, onNoise,
  //        state, random }
  const { colliders, smokes, state } = ctx;
  const tmp = { x: 0, z: 0 };
  for (const bot of bots) {
    if (!bot.alive) continue;
    // --- Perception: find the nearest visible enemy. ---
    let target = null, targetDist = Infinity, targetIsPlayer = false;
    const candidates = [];
    if (ctx.playerAlive && bot.team === 'ember') candidates.push({ x: ctx.playerPos.x, z: ctx.playerPos.z, y: 1.4, isPlayer: true, speed: ctx.playerSpeed, crouched: ctx.playerCrouched });
    for (const other of bots) {
      if (!other.alive || other.team === bot.team) continue;
      candidates.push({ x: other.pos.x, z: other.pos.z, y: 1.2, isPlayer: false, bot: other, speed: 3, crouched: false });
    }
    for (const c of candidates) {
      const dx = c.x - bot.pos.x, dz = c.z - bot.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SIGHT_RANGE || dist < 0.6) continue;
      // In front? Bots turn toward their walk direction, so use a wide cone.
      const ang = Math.atan2(dx, dz);
      let diff = Math.abs(ang - bot.yaw);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > 1.9) continue;
      if (segmentBlocked(bot.pos.x, bot.pos.z, c.x, c.z, colliders, 1.2)) continue;
      if (smokeBlocks(bot.pos.x, bot.pos.z, c.x, c.z, smokes)) continue;
      if (dist < targetDist) { target = c; targetDist = dist; targetIsPlayer = !!c.isPlayer; }
    }

    if (target) {
      // --- Engage: face the target, fire in bursts. ---
      bot.state = 'engage';
      bot.yaw = Math.atan2(target.x - bot.pos.x, target.z - bot.pos.z);
      bot.shootT -= dt;
      if (bot.burstLeft <= 0) {
        bot.burstPause -= dt;
        if (bot.burstPause <= 0) { bot.burstLeft = 2 + Math.floor(ctx.random() * 3); bot.burstPause = 0.5 + ctx.random() * 0.7; }
      } else if (bot.shootT <= 0) {
        bot.shootT = bot.weapon.fireRate + 0.05;
        bot.burstLeft -= 1;
        fireAt(bot, target, targetDist, ctx, targetIsPlayer);
      }
      // Plant/defuse progress freezes while fighting.
      bot.plantT = 0; bot.defuseT = 0;
    } else {
      // --- Objective / route. ---
      bot.shootT = 0;
      if (bot.team === 'ember' && state.bomb.carrier === bot && state.bomb.status === 'carried') {
        const site = state.bomb.site;
        const dSite = Math.hypot(site.x - bot.pos.x, site.z - bot.pos.z);
        if (dSite < site.r) {
          bot.state = 'plant';
          bot.plantT += dt;
          bot.yaw += dt * 0.8;
          if (bot.plantT >= 4) { ctx.onPlant(bot); bot.plantT = 0; }
        } else {
          bot.state = 'advance';
          moveAlongPath(bot, dt, colliders, tmp, ctx);
        }
      } else if (bot.team === 'vanguard' && state.bomb.status === 'planted') {
        const dBomb = Math.hypot(state.bomb.x - bot.pos.x, state.bomb.z - bot.pos.z);
        if (dBomb < 1.6) {
          bot.state = 'defuse';
          bot.defuseT += dt;
          if (bot.defuseT >= 5) { ctx.onDefuse(bot); bot.defuseT = 0; }
        } else {
          bot.goalNode = nearestNode(state.bomb.x, state.bomb.z);
          bot.path = bfsPath(MAP.waypoints, nearestNode(bot.pos.x, bot.pos.z), bot.goalNode);
          bot.pathIdx = 0;
          bot.state = 'advance';
          moveAlongPath(bot, dt, colliders, tmp, ctx);
        }
      } else if (bot.state === 'hold') {
        bot.holdT -= dt;
        if (bot.holdT <= 0) {
          bot.state = 'advance';
          bot.goalNode = 2 + Math.floor(ctx.random() * 8);
          bot.path = bfsPath(MAP.waypoints, nearestNode(bot.pos.x, bot.pos.z), bot.goalNode);
          bot.pathIdx = 0;
        }
      } else {
        bot.state = 'advance';
        moveAlongPath(bot, dt, colliders, tmp, ctx);
        if (bot.pathIdx >= bot.path.length) {
          bot.state = 'hold';
          bot.holdT = 2 + ctx.random() * 4;
        }
      }
    }

    // Sync the mesh. No allocation in this loop beyond the reuse above.
    bot.mesh.position.set(bot.pos.x, 0, bot.pos.z);
    bot.mesh.rotation.y = bot.yaw;
  }
}

function moveAlongPath(bot, dt, colliders, tmp, ctx) {
  if (bot.pathIdx >= bot.path.length) {
    bot.path = bfsPath(MAP.waypoints, nearestNode(bot.pos.x, bot.pos.z), bot.goalNode);
    bot.pathIdx = 0;
    if (!bot.path.length) return;
  }
  const wp = MAP.waypoints[bot.path[bot.pathIdx]];
  const dx = wp.x - bot.pos.x, dz = wp.z - bot.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.7) { bot.pathIdx += 1; bot.node = bot.path[bot.pathIdx - 1] ?? bot.node; return; }
  const step = BOT_SPEED * dt;
  bot.pos.x += (dx / dist) * step;
  bot.pos.z += (dz / dist) * step;
  bot.yaw = Math.atan2(dx, dz);
  resolveCircle(bot.pos.x, bot.pos.z, 0.38, colliders, tmp);
  bot.pos.x = tmp.x; bot.pos.z = tmp.z;
  // Separation: don't stack on a teammate.
  for (const other of ctx.bots) {
    if (other === bot || !other.alive) continue;
    const ox = bot.pos.x - other.pos.x, oz = bot.pos.z - other.pos.z;
    const d2 = ox * ox + oz * oz;
    if (d2 < 0.81 && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      bot.pos.x = other.pos.x + (ox / d) * 0.9;
      bot.pos.z = other.pos.z + (oz / d) * 0.9;
    }
  }
}

function smokeBlocks(x0, z0, x1, z1, smokes) {
  for (const s of smokes) {
    // Does the segment pass within the cloud's radius?
    const dx = x1 - x0, dz = z1 - z0;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((s.x - x0) * dx + (s.z - z0) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = x0 + dx * t, pz = z0 + dz * t;
    if ((px - s.x) ** 2 + (pz - s.z) ** 2 < s.radius * s.radius) return true;
  }
  return false;
}

function fireAt(bot, target, dist, ctx, isPlayer) {
  // Hit chance: close and still = deadly; far and moving = spray and pray.
  let chance = 0.42 - dist * 0.006;
  if (target.speed > 2) chance -= 0.12;
  if (target.crouched) chance -= 0.08;
  chance = Math.max(0.05, Math.min(0.6, chance));
  const hit = ctx.random() < chance;
  const from = { x: bot.pos.x, y: 1.35, z: bot.pos.z };
  const to = { x: target.x, y: target.y, z: target.z };
  ctx.tracer(from, to, hit);
  ctx.noise(bot.pos.x, bot.pos.z, 25);
  if (!hit) return;
  const head = ctx.random() < 0.12;
  const dmg = Math.round(bot.weapon.damage * (head ? bot.weapon.headMult : 1) * (dist > 25 ? 0.8 : 1));
  if (isPlayer) ctx.damagePlayer(dmg, bot);
  else ctx.damageBot(target.bot, dmg, bot);
}

export function killBot(bot) {
  bot.alive = false;
  bot.dead = true;
  bot.mesh.rotation.x = -Math.PI / 2;
  bot.mesh.position.y = 0.35;
}
