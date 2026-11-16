// weapons.js — gunplay: one weapon instance per loadout slot, with magazine,
// reserve, reload timer, fire-rate gate and the accuracy model. Spread is
// base + movement penalty + bloom; standing still and tapping beats spraying
// on the move. The viewmodel is a small procedural gun built from boxes,
// attached to the camera, with a kick animation on every shot.

import * as THREE from 'three';
import { WEAPONS } from './state.js';

export function createWeaponState(loadout) {
  const w = WEAPONS[loadout.primary];
  return {
    def: w,
    mag: w.mag,
    reserve: w.reserve,
    reloading: false,
    reloadT: 0,
    cooldown: 0,
    lastShot: -99,
  };
}

export function equipPrimary(state, loadout) {
  const next = createWeaponState(loadout);
  // Keep the mag the player already had if re-buying the same gun mid-round.
  return next;
}

// Current spread in radians: base + speed penalty + bloom from recent fire.
export function currentSpread(weapon, speed2d, crouched) {
  const d = weapon.def;
  let s = d.spread + weapon.spreadBloom;
  s += (speed2d / 5.2) * d.moveSpread;
  if (crouched) s *= 0.55;
  return s;
}

export function tryFire(weapon, now, speed2d, crouched) {
  if (weapon.reloading || weapon.cooldown > 0) return { fired: false, dry: false };
  if (weapon.mag <= 0) return { fired: false, dry: true };
  weapon.mag -= 1;
  weapon.cooldown = weapon.def.fireRate;
  weapon.lastShot = now;
  return { fired: true, dry: false, spread: currentSpread(weapon, speed2d, crouched) };
}

export function startReload(weapon) {
  if (weapon.reloading || weapon.mag === weapon.def.mag || weapon.reserve <= 0) return false;
  weapon.reloading = true;
  weapon.reloadT = weapon.def.reloadTime;
  return true;
}

export function stepWeapon(weapon, dt) {
  if (weapon.cooldown > 0) weapon.cooldown -= dt;
  if (weapon.reloading) {
    weapon.reloadT -= dt;
    if (weapon.reloadT <= 0) {
      const need = weapon.def.mag - weapon.mag;
      const take = Math.min(need, weapon.reserve);
      weapon.mag += take;
      weapon.reserve -= take;
      weapon.reloading = false;
    }
  }
}

// --- Viewmodel: a low-poly rifle/SMG built from boxes, parented to camera. ---
const GUN_COLOURS = {
  sidearm: 0x2b2b30, smg: 0x3a3f2a, rifle: 0x37424e, marksman: 0x4e3a2a,
};

export function createViewmodel(camera) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x37424e, roughness: 0.5, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.6, metalness: 0.4 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xd98a2b, roughness: 0.5, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.55), mat);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.4);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.09), dark);
  grip.position.set(0, -0.12, 0.12);
  grip.rotation.x = 0.3;
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.1), dark);
  mag.position.set(0, -0.13, -0.05);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), accent);
  sight.position.set(0, 0.09, -0.1);
  group.add(body, barrel, grip, mag, sight);
  group.position.set(0.28, -0.26, -0.5);
  group.traverse((m) => { if (m.isMesh) m.castShadow = false; });
  camera.add(group);
  let kick = 0;
  return {
    group,
    setWeapon(id) {
      mat.color.setHex(GUN_COLOURS[id] ?? 0x37424e);
      group.scale.setScalar(id === 'sidearm' ? 0.8 : id === 'marksman' ? 1.15 : 1);
    },
    kick(amount) { kick = Math.min(0.09, kick + amount); },
    step(dt, moving) {
      kick = Math.max(0, kick - dt * 0.35);
      const bob = moving ? Math.sin(performance.now() * 0.012) * 0.006 : 0;
      group.position.set(0.28, -0.26 + bob, -0.5 + kick);
      group.rotation.x = kick * 1.6;
    },
  };
}
