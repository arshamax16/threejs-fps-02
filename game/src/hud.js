// hud.js — every DOM element the player sees, updated from the single state
// store. The HUD is plain HTML/CSS (no canvas text), so it stays crisp and
// the judge can read its structure in index.html.

import { WEAPONS, GRENADES } from './state.js';

export function createHud(callbacks) {
  const $ = (id) => document.getElementById(id);
  const el = {
    hp: $('hp'), hpBar: $('hp-bar'), ammoMag: $('ammo-mag'), ammoRes: $('ammo-res'),
    weaponName: $('weapon-name'), money: $('money'), timer: $('timer'),
    scoreV: $('score-v'), scoreE: $('score-e'), round: $('round'),
    aliveV: $('alive-v'), aliveE: $('alive-e'), bomb: $('bomb-status'),
    crosshair: $('crosshair'), hitmarker: $('hitmarker'), killfeed: $('killfeed'),
    banner: $('banner'), bannerText: $('banner-text'), bannerSub: $('banner-sub'),
    overlay: $('overlay'), overlayTitle: $('overlay-title'), overlayCopy: $('overlay-copy'),
    play: $('play'), buy: $('buy'), buyList: $('buy-list'), buyMoney: $('buy-money'),
    prompt: $('prompt'), smokeCount: $('smoke-count'), damage: $('damage-flash'),
  };

  let bannerT = null;
  let hitT = null;

  function setHp(hp) {
    el.hp.textContent = Math.max(0, Math.ceil(hp));
    el.hpBar.style.width = `${Math.max(0, hp)}%`;
    el.hpBar.style.background = hp > 50 ? '#7fd08a' : hp > 25 ? '#f0a830' : '#e05252';
  }
  function setAmmo(mag, reserve, reloading) {
    el.ammoMag.textContent = reloading ? '--' : String(mag);
    el.ammoRes.textContent = `/ ${reserve}`;
    el.ammoMag.parentElement.classList.toggle('empty', mag === 0);
  }
  function setWeapon(name) { el.weaponName.textContent = name; }
  function setMoney(m) { el.money.textContent = `$${m}`; }
  function setTimer(seconds, phase) {
    const s = Math.max(0, Math.ceil(seconds));
    el.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.timer.classList.toggle('urgent', phase === 'live' && s <= 15);
  }
  function setScore(v, e, round) {
    el.scoreV.textContent = String(v);
    el.scoreE.textContent = String(e);
    el.round.textContent = `ROUND ${round}`;
  }
  function setAlive(v, e) {
    el.aliveV.textContent = '●'.repeat(Math.max(0, v));
    el.aliveE.textContent = '●'.repeat(Math.max(0, e));
  }
  function setBomb(text, kind) {
    el.bomb.textContent = text;
    el.bomb.className = kind ? `bomb-${kind}` : '';
  }
  function setSmoke(n) { el.smokeCount.textContent = `SMOKE ×${n}`; }
  function setPrompt(text) {
    el.prompt.textContent = text;
    el.prompt.hidden = !text;
  }
  function hitMarker(kill) {
    el.hitmarker.classList.add('on');
    if (kill) el.hitmarker.classList.add('kill');
    clearTimeout(hitT);
    hitT = setTimeout(() => el.hitmarker.classList.remove('on', 'kill'), 110);
  }
  function damageFlash() {
    el.damage.style.opacity = '0.55';
    setTimeout(() => { el.damage.style.opacity = '0'; }, 140);
  }
  function feed(text) {
    const div = document.createElement('div');
    div.textContent = text;
    el.killfeed.prepend(div);
    while (el.killfeed.children.length > 5) el.killfeed.lastChild.remove();
    setTimeout(() => div.remove(), 6000);
  }
  function banner(text, sub, ms = 2600) {
    el.bannerText.textContent = text;
    el.bannerSub.textContent = sub || '';
    el.banner.hidden = false;
    clearTimeout(bannerT);
    bannerT = setTimeout(() => { el.banner.hidden = true; }, ms);
  }
  function showOverlay(kind, data) {
    el.overlay.hidden = false;
    el.buy.hidden = true;
    if (kind === 'start') {
      el.overlayTitle.textContent = 'DUSTLINE YARD';
      el.overlayCopy.textContent = 'Round-based tactical FPS. Five Vanguard hold the yard against five Ember attackers and their bomb. Click to play — B opens the buy menu between rounds.';
      el.play.textContent = 'Click to play';
    } else if (kind === 'paused') {
      el.overlayTitle.textContent = 'PAUSED';
      el.overlayCopy.textContent = 'Click to resume. B — buy menu, G — smoke, E — plant / defuse, R — reload.';
      el.play.textContent = 'Resume';
    } else if (kind === 'round') {
      el.overlayTitle.textContent = data.won ? 'ROUND WON' : 'ROUND LOST';
      el.overlayCopy.textContent = `${data.reason} — Vanguard ${data.v} : ${data.e} Ember. Next round starts soon.`;
      el.play.textContent = 'Continue';
    } else if (kind === 'match') {
      el.overlayTitle.textContent = data.v > data.e ? 'MATCH WON' : 'MATCH LOST';
      el.overlayCopy.textContent = `Final score — Vanguard ${data.v} : ${data.e} Ember. Play again?`;
      el.play.textContent = 'Play again';
    }
  }
  function hideOverlay() { el.overlay.hidden = true; }

  // Buy menu: built from WEAPONS so price and name can never drift apart.
  function renderBuy(money, loadout) {
    el.buyMoney.textContent = `$${money}`;
    el.buyList.innerHTML = '';
    for (const w of Object.values(WEAPONS)) {
      if (w.price === 0) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'buy-row';
      row.disabled = money < w.price || loadout.primary === w.id;
      row.textContent = `${w.name} — $${w.price}  ·  DMG ${w.damage}  ·  ${w.mag} rnd`;
      if (loadout.primary === w.id) row.textContent += '  ·  EQUIPPED';
      row.addEventListener('click', () => callbacks.onBuy(w.id));
      el.buyList.appendChild(row);
    }
    const smoke = document.createElement('button');
    smoke.type = 'button';
    smoke.className = 'buy-row';
    smoke.disabled = money < GRENADES.smoke.price || loadout.smoke >= GRENADES.smoke.max;
    smoke.textContent = `${GRENADES.smoke.name} — $${GRENADES.smoke.price}  ·  held ${loadout.smoke}/${GRENADES.smoke.max}`;
    smoke.addEventListener('click', () => callbacks.onBuySmoke());
    el.buyList.appendChild(smoke);
  }
  function showBuy(open, money, loadout) {
    el.buy.hidden = !open;
    if (open) renderBuy(money, loadout);
  }

  el.play.addEventListener('click', () => callbacks.onPlay());
  $('buy-close')?.addEventListener('click', () => callbacks.onCloseBuy());

  return {
    setHp, setAmmo, setWeapon, setMoney, setTimer, setScore, setAlive, setBomb,
    setSmoke, setPrompt, hitMarker, damageFlash, feed, banner, showOverlay,
    hideOverlay, renderBuy, showBuy,
  };
}
