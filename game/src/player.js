// player.js — first-person movement: acceleration, friction, crouch, jump,
// AABB collision, recoil and spread. The simulation is fixed-step (main.js
// calls step(dt) at 60 Hz); rendering only reads body.position / yaw / pitch.

import { resolveCircle } from './world.js';

const EYE_STAND = 1.62;
const EYE_CROUCH = 1.05;
const RADIUS = 0.38;
const WALK_SPEED = 5.2;
const CROUCH_SPEED = 2.6;
const ACCEL = 42;
const FRICTION = 9.5;

export function createPlayer(colliders) {
  const body = {
    position: { x: 0, y: 0, z: 18 },
    velocity: { x: 0, z: 0 },
    yaw: 0, pitch: 0,
    eye: EYE_STAND,
    crouched: false,
    onGround: true,
    vy: 0,
    hp: 100,
    alive: true,
    // Recoil offsets decay back to zero; spread grows while firing/moving.
    recoilPitch: 0,
    recoilYaw: 0,
    spreadBloom: 0,
    speed2d: 0,
  };
  const tmp = { x: 0, z: 0 };

  function look(dx, dy) {
    body.yaw -= dx * 0.0022;
    body.pitch -= dy * 0.0022;
    body.pitch = Math.max(-1.5, Math.min(1.5, body.pitch));
  }

  function step(dt, keys) {
    if (!body.alive) return;
    const crouch = keys.has('ControlLeft') || keys.has('KeyC');
    body.crouched = crouch;
    const targetEye = crouch ? EYE_CROUCH : EYE_STAND;
    body.eye += (targetEye - body.eye) * Math.min(1, dt * 12);

    // Wish direction from keys, rotated by yaw. Acceleration, not teleport:
    // stopping to aim pays because spread scales with speed (weapons.js).
    let fx = 0, fz = 0;
    if (keys.has('KeyW')) fz -= 1;
    if (keys.has('KeyS')) fz += 1;
    if (keys.has('KeyA')) fx -= 1;
    if (keys.has('KeyD')) fx += 1;
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;
    const sin = Math.sin(body.yaw), cos = Math.cos(body.yaw);
    const wx = fx * cos - fz * sin;
    const wz = fx * sin + fz * cos;
    const maxSpeed = crouch ? CROUCH_SPEED : WALK_SPEED;
    body.velocity.x += wx * ACCEL * dt;
    body.velocity.z += wz * ACCEL * dt;
    // Friction when no input; clamp to max speed.
    const sp = Math.hypot(body.velocity.x, body.velocity.z);
    if (fx === 0 && fz === 0 && sp > 0) {
      const drop = Math.max(0, sp - FRICTION * dt * sp);
      body.velocity.x *= drop / sp;
      body.velocity.z *= drop / sp;
    }
    if (sp > maxSpeed) {
      body.velocity.x *= maxSpeed / sp;
      body.velocity.z *= maxSpeed / sp;
    }
    body.speed2d = Math.hypot(body.velocity.x, body.velocity.z);

    body.position.x += body.velocity.x * dt;
    body.position.z += body.velocity.z * dt;
    resolveCircle(body.position.x, body.position.z, RADIUS, colliders, tmp);
    body.position.x = tmp.x;
    body.position.z = tmp.z;

    // Jump (Space) — small, no bunny-hop exploit: one jump per landing.
    if (keys.has('Space') && body.onGround) {
      body.vy = 5.2;
      body.onGround = false;
    }
    if (!body.onGround) {
      body.vy -= 16 * dt;
      body.position.y += body.vy * dt;
      if (body.position.y <= 0) { body.position.y = 0; body.vy = 0; body.onGround = true; }
    }

    // Recoil and bloom decay.
    body.recoilPitch *= Math.max(0, 1 - dt * 7);
    body.recoilYaw *= Math.max(0, 1 - dt * 7);
    body.spreadBloom = Math.max(0, body.spreadBloom - dt * 0.05);
  }

  function applyRecoil(pitch, yaw) {
    body.recoilPitch += pitch;
    body.recoilYaw += yaw;
    body.spreadBloom = Math.min(0.06, body.spreadBloom + pitch * 0.9);
    body.pitch += pitch * 0.55;
  }

  function resetSpawn(x, z, yaw) {
    body.position.x = x; body.position.z = z; body.position.y = 0;
    body.velocity.x = 0; body.velocity.z = 0;
    body.yaw = yaw; body.pitch = 0;
    body.hp = 100; body.alive = true;
    body.recoilPitch = 0; body.recoilYaw = 0; body.spreadBloom = 0;
  }

  return { body, look, step, applyRecoil, resetSpawn };
}
