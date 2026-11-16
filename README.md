# Dustline Yard — a three.js tactical FPS

[![threejs-fps-02](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/arshamax16/threejs-fps-02/rank.svg)](https://make.fun/bounty/threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/arshamax16/threejs-fps-02/reward.svg)](https://make.fun/bounty/threejs-fps-02)

A round-based tactical first-person shooter in the style Counter-Strike made
famous — with its own map, weapons, art and names. Built for the make.fun
competition **threejs-fps-02** ($1,000). Runs entirely offline from static
files on three.js 0.187.0 (vendored under `game/vendor/three/`).

## The game

**Dustline Yard** — a sun-baked 64×44 m yard. Five **Vanguard** defenders
(you + 4 bot teammates, teal) hold two bombsites, A (west) and B (east),
against five **Ember** attackers (amber) who carry a bomb down the west lane,
the mid lane or the east lane.

- **Rounds**: buy phase (14 s) → live round (100 s) → round end → next round.
  First team to 5 rounds wins the match. A round ends when one team is
  eliminated, when the bomb explodes (Ember win), when it is defused
  (Vanguard win), or when time expires (Vanguard win).
- **Bomb objective**: the Ember carrier plants at a site (4 s channel). Hold
  **E** near a planted bomb for 5 s to defuse it.
- **Economy**: $800 to start, $3,250 for a round win, $1,400 for a loss,
  $300 per kill. Press **B** in the buy phase to shop.
- **Weapons** (original names): P9 Sidearm, VK-9 Ripper SMG, AR-77 Longshot
  rifle, DMR-50 Falcon marksman rifle — plus Smoke Canisters (**G**) that
  block bot sight. Headshots deal 3–4× damage.
- **Gunplay where accuracy beats speed**: hitscan with recoil, bloom and a
  movement spread penalty; standing still and tapping beats spraying on the
  move. Reload (**R**), limited magazines and reserves, crouch (**Ctrl**),
  jump (**Space**).
- **Bots**: route along a waypoint graph (BFS), hold positions, see and shoot
  back in bursts, react to gunfire, plant and defuse.
- **HUD**: health, ammo, round timer, score, money, team alive counts, bomb
  status, killfeed, buy-phase prompt.

## Play

```sh
node serve.ts        # serves game/ at http://localhost:8080
```

Open the page in desktop Chrome, click **Click to play**, and fight. All
art is procedural three.js geometry; all sound is synthesised with WebAudio.
No network requests, no external assets.

## Layout

- `game/index.html` — page + HUD + the single import map for `three`
- `game/src/main.js` — boot, fixed 60 Hz simulation, round/bomb flow, shooting
- `game/src/state.js` — the single state store: weapons, economy, round rules
- `game/src/world.js` — the Dustline Yard map, AABB colliders, line of sight
- `game/src/player.js` — movement: acceleration, crouch, jump, recoil
- `game/src/weapons.js` — fire/reload/spread model + procedural viewmodel gun
- `game/src/bots.js` — bot bodies, waypoint routing, perception, combat
- `game/src/hud.js` — DOM HUD, buy menu, overlays, killfeed
- `game/src/audio.js` — synthesised WebAudio sound effects
- `main.ts` — the make.fun entry program (copies game/ + screenshots/ to
  `/output` and writes `dossier.json`)
- `screenshots/` — real renders of this game, taken in headless Chrome

## Screenshot modes

`?shot=start|play|end` renders one deterministic frame and freezes it
(`window.__shotReady`), used to take the screenshots in `screenshots/`.

## License

MIT — see `LICENSE`.
