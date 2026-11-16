// world.js — "Dustline Yard": an original map, built from procedural geometry.
// Layout (X east, Z south; metres): a 64 x 44 yard. Vanguard spawns south,
// Ember spawns north. Site A (west) and Site B (east) sit at the north end,
// joined by a mid lane with a broken arch. Crates and walls make corners and
// sightlines; nothing here copies any commercial map.
//
// Colliders are plain AABBs { minX, maxX, minZ, maxZ, h } so movement, bot
// pathing and line-of-sight all share one cheap representation. Rendering
// reuses a small set of materials — one chosen palette: sun-baked ochre walls,
// teal steel, dusty ground, amber hazard stripes.

import * as THREE from 'three';

export const MAP = {
  halfX: 32,
  halfZ: 22,
  // Bombsites (centres) and spawn points.
  siteA: { x: -24, z: -15, r: 5 },
  siteB: { x: 24, z: -15, r: 5 },
  vanguardSpawn: [
    { x: -6, z: 18 }, { x: -2, z: 19 }, { x: 2, z: 19 }, { x: 6, z: 18 }, { x: 0, z: 16 },
  ],
  emberSpawn: [
    { x: -6, z: -18 }, { x: -2, z: -19 }, { x: 2, z: -19 }, { x: 6, z: -18 }, { x: 0, z: -16 },
  ],
  // Waypoint graph bots walk: node { x, z, links: [indices] }.
  waypoints: [
    { x: 0, z: 18, links: [1, 2, 3] },      // 0 vanguard yard
    { x: -12, z: 8, links: [0, 4, 5] },    // 1 west lane
    { x: 0, z: 6, links: [0, 4, 6, 7] },   // 2 mid lane
    { x: 12, z: 8, links: [0, 6, 7] },     // 3 east lane
    { x: -24, z: -6, links: [1, 2, 8] },   // 4 A approach
    { x: -12, z: -12, links: [1, 4, 8] },  // 5 A corner
    { x: 24, z: -6, links: [2, 3, 9] },    // 6 B approach
    { x: 12, z: -12, links: [3, 6, 9] },   // 7 B corner
    { x: -24, z: -15, links: [4, 5] },     // 8 SITE A
    { x: 24, z: -15, links: [6, 7] },      // 9 SITE B
    { x: 0, z: -18, links: [2, 8, 9] },    // 10 ember yard
  ],
};

// Static boxes: [cx, cz, w, d, h, colourKey]. Walls first, then crates.
const BOXES = [
  // Perimeter (h 4, thick 1)
  [0, -22.5, 66, 1, 4, 'wall'], [0, 22.5, 66, 1, 4, 'wall'],
  [-32.5, 0, 1, 46, 4, 'wall'], [32.5, 0, 1, 46, 4, 'wall'],
  // Mid arch pillars + crossbeam gap (two pillars, sightline between them)
  [-3, 0, 1.2, 1.2, 4.5, 'steel'], [3, 0, 1.2, 1.2, 4.5, 'steel'],
  // Central block dividing mid from the lanes
  [0, -8, 8, 1.2, 3.2, 'wall'],
  // A-site cover: L of crates
  [-24, -10, 6, 1.2, 1.4, 'crate'], [-20.5, -13, 1.2, 4, 1.4, 'crate'],
  [-27, -18, 3, 2, 1.1, 'crate'],
  // B-site cover
  [24, -10, 6, 1.2, 1.4, 'crate'], [20.5, -13, 1.2, 4, 1.4, 'crate'],
  [27, -18, 3, 2, 1.1, 'crate'],
  // Lane crates (crouch cover + corners)
  [-14, 4, 2.4, 2.4, 1.3, 'crate'], [14, 4, 2.4, 2.4, 1.3, 'crate'],
  [-8, 12, 3, 1.2, 1.2, 'crate'], [8, 12, 3, 1.2, 1.2, 'crate'],
  [-18, -2, 1.6, 1.6, 2.2, 'crate'], [18, -2, 1.6, 1.6, 2.2, 'crate'],
  // Spawn cover
  [-10, 16, 4, 1.2, 1.2, 'crate'], [10, 16, 4, 1.2, 1.2, 'crate'],
  [-10, -16, 4, 1.2, 1.2, 'crate'], [10, -16, 4, 1.2, 1.2, 'crate'],
];

const COLOURS = {
  wall: 0xb98d5e, steel: 0x2e6f73, crate: 0x8a6b42, ground: 0x9c8a6d,
  groundDark: 0x7d6f57, hazard: 0xd98a2b, sky: 0x87a8c8,
};

export function createWorld(scene) {
  const colliders = [];
  const group = new THREE.Group();
  scene.add(group);

  const groundMat = new THREE.MeshStandardMaterial({ color: COLOURS.ground, roughness: 0.95 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(66, 46), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // Painted lane strips on the ground so the map reads at a glance.
  const stripMat = new THREE.MeshStandardMaterial({ color: COLOURS.groundDark, roughness: 1 });
  for (const [x, z, w, d] of [[-24, -8, 5, 30], [24, -8, 5, 30], [0, 4, 5, 34]]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(w, d), stripMat);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(x, 0.01, z);
    strip.receiveShadow = true;
    group.add(strip);
  }

  const mats = {};
  for (const key of ['wall', 'steel', 'crate']) {
    mats[key] = new THREE.MeshStandardMaterial({ color: COLOURS[key], roughness: 0.85, metalness: key === 'steel' ? 0.35 : 0.05 });
  }
  const geoCache = new Map();
  function boxGeo(w, h, d) {
    const key = `${w}|${h}|${d}`;
    if (!geoCache.has(key)) geoCache.set(key, new THREE.BoxGeometry(w, h, d));
    return geoCache.get(key);
  }

  for (const [cx, cz, w, d, h, key] of BOXES) {
    const mesh = new THREE.Mesh(boxGeo(w, h, d), mats[key]);
    mesh.position.set(cx, h / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, h });
  }

  // Mid arch crossbeam (visual only, high above head height).
  const beam = new THREE.Mesh(boxGeo(7.2, 0.8, 1.4), mats.steel);
  beam.position.set(0, 4.6, 0);
  beam.castShadow = true;
  group.add(beam);

  // Bombsite markers: flat amber rings on the ground + a floating letter board.
  for (const [site, letter] of [[MAP.siteA, 'A'], [MAP.siteB, 'B']]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.r - 0.4, site.r, 40),
      new THREE.MeshBasicMaterial({ color: COLOURS.hazard, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.02, site.z);
    group.add(ring);
    const board = new THREE.Mesh(boxGeo(2.2, 2.2, 0.15),
      new THREE.MeshStandardMaterial({ color: 0x22201c, roughness: 0.6 }));
    board.position.set(site.x, 3.4, site.z - site.r - 0.4);
    group.add(board);
    const letterMesh = new THREE.Mesh(boxGeo(1.1, 1.1, 0.05),
      new THREE.MeshBasicMaterial({ color: COLOURS.hazard }));
    letterMesh.position.set(site.x, 3.4, site.z - site.r - 0.3);
    group.add(letterMesh);
    void letter;
  }

  // Lighting: warm sun + cool sky fill, one shadow-casting light only.
  const sun = new THREE.DirectionalLight(0xffe6bf, 2.4);
  sun.position.set(18, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -40; sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
  sun.shadow.camera.far = 90;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x87a8c8, 0x6b5a44, 0.9));
  scene.fog = new THREE.Fog(0x87a8c8, 55, 110);

  return { colliders, group };
}

// 2D segment vs AABB test (XZ plane) — shared by movement, bots and LOS.
export function segmentBlocked(x0, z0, x1, z1, colliders, minH = 1.2) {
  for (const c of colliders) {
    if (c.h < minH) continue;
    if (segmentHitsBox(x0, z0, x1, z1, c)) return true;
  }
  return false;
}

function segmentHitsBox(x0, z0, x1, z1, c) {
  const dx = x1 - x0, dz = z1 - z0;
  let tmin = 0, tmax = 1;
  for (const [p, d, lo, hi] of [[x0, dx, c.minX, c.maxX], [z0, dz, c.minZ, c.maxZ]]) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) return false; }
    else {
      let t1 = (lo - p) / d, t2 = (hi - p) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

// Circle (radius r) vs AABBs: push the circle out; returns corrected x/z.
export function resolveCircle(x, z, r, colliders, out) {
  let nx = x, nz = z;
  for (const c of colliders) {
    const cx = Math.max(c.minX, Math.min(nx, c.maxX));
    const cz = Math.max(c.minZ, Math.min(nz, c.maxZ));
    const dx = nx - cx, dz = nz - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        nx = cx + (dx / d) * r;
        nz = cz + (dz / d) * r;
      } else {
        // Centre inside the box: push out along the smallest penetration axis.
        const pl = nx - c.minX, pr = c.maxX - nx, pt = nz - c.minZ, pb = c.maxZ - nz;
        const m = Math.min(pl, pr, pt, pb);
        if (m === pl) nx = c.minX - r; else if (m === pr) nx = c.maxX + r;
        else if (m === pt) nz = c.minZ - r; else nz = c.maxZ + r;
      }
    }
  }
  nx = Math.max(-MAP.halfX + 0.5, Math.min(MAP.halfX - 0.5, nx));
  nz = Math.max(-MAP.halfZ + 0.5, Math.min(MAP.halfZ - 0.5, nz));
  out.x = nx; out.z = nz;
  return out;
}
