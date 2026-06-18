/**
 * BuffManager - Buff生命周期统一管理
 */

const { deepClone } = require("./util");

// ========== Buff 定义 ==========
const BUFF_DEFS = {
  "🩸": {
    name: "血怒",
    trigger: "duringTurn",
    desc: "本回合打出的攻击牌额外+1伤害（每张牌+1），回合结束时移除",
  },
  "⛈️": {
    name: "雷暴诅咒",
    trigger: "roundStart",
    desc: "持续一轮：每个玩家回合开始时，被诅咒者受到1点真实伤害；到法师回合时清除",
  },
  "🙏": {
    name: "祈祷",
    trigger: "playCount",
    desc: "法师每再出2张牌，自动抽1张牌",
  },
  "🫥": {
    name: "隐身",
    trigger: "selfTurnStart",
    desc: "自身回合开始时移除（持续一回合免伤，SYSTEM伤害穿透）",
  },
  "⚖️": {
    name: "审判印记",
    trigger: "onCardPlayed",
    desc: "每打出一张牌受到1点SYSTEM真实伤害，回合结束时移除，不可叠加",
  },
};

function addBuff(state, playerId, buffId) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;
  if (!player.buffs.includes(buffId)) {
    player.buffs.push(buffId);
  }
  return s;
}

function removeBuff(state, playerId, buffId) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;
  player.buffs = player.buffs.filter((b) => b !== buffId);
  return s;
}

/**
 * ⛈️ 雷暴诅咒：每个玩家回合开始时，所有带⛈️的人受到1点真实伤害
 *            当诅咒施法者回合开始时，清除所有⛈️
 * 🫥 隐身：回合开始时移除
 */
function onTurnStart(state, playerId) {
  let s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player || !player.isAlive) return s;

  const { dealDamage } = require("./gameEngine");

  // 🫥 隐身清除
  if (player.buffs.includes("🫥")) {
    player.buffs = player.buffs.filter((b) => b !== "🫥");
  }

  // ⛈️ 雷暴诅咒：每个玩家回合开始时，诅咒目标受到1点真实伤害（无视护盾）
  for (const p of s.players) {
    if (p.buffs.includes("⛈️") && p.isAlive) {
      s = dealDamage(s, "SYSTEM", p.id, 1, true, 0);
    }
  }

  // ⛈️ 施法者回合开始 → 清除全场的⛈️
  if (s._curseCasterId === playerId) {
    for (const p of s.players) {
      p.buffs = p.buffs.filter((b) => b !== "⛈️");
    }
    s._curseCasterId = null;
  }

  return s;
}

/**
 * 🩸 血怒：回合结束时移除（本回合内攻击牌伤害+1）
 */
function onTurnEnd(state, playerId) {
  let s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player || !player.isAlive) return s;

  const { dealDamage } = require("./gameEngine");

  // 🩸 血怒：回合结束移除
  if (player.buffs.includes("🩸")) {
    player.buffs = player.buffs.filter((b) => b !== "🩸");
    s.gameLogs = s.gameLogs || [];
    s.gameLogs.push("🩸 血怒效果结束");
  }

  // 🙏 祈祷：持续一回合，回合结束时清除
  if (player.buffs.includes("🙏")) {
    player.buffs = player.buffs.filter((b) => b !== "🙏");
    player._prayerCount = 0;
  }

  // ⚖️ 审判印记：持有者回合结束时清除
  if (player.buffs.includes("⚖️")) {
    player.buffs = player.buffs.filter((b) => b !== "⚖️");
    s.gameLogs = s.gameLogs || [];
    s.gameLogs.push("⚖️ " + (player.nickname || player.character || playerId) + " 审判印记消失");
  }

  // 🐯 虎形态回合结束变回人
  if (player.beastForm === "tiger") {
    player.beastForm = null;
  }

  return s;
}

/**
 * ⚖️ 审判印记：出牌玩家若有印记，每打1张牌受1点SYSTEM真实伤害
 * 在 applySingleCard 中每次出牌后调用
 */
function onCardPlayed(state, playerId) {
  let s = deepClone(state);
  const player = s.players.find(p => p.id === playerId);
  if (!player || !player.isAlive || !player.buffs.includes("⚖️")) return s;

  const { dealDamage } = require("./gameEngine");
  s = dealDamage(s, "SYSTEM", playerId, 1, true, 0);
  s.gameLogs = s.gameLogs || [];
  s.gameLogs.push("⚖️ 审判印记触发：" + (player.nickname || player.character || playerId) + " 受到1点真实伤害");
  return s;
}

/**
 * 🙏 祈祷：检查法师出牌计数，每2张抽1张
 */
function checkPrayerDraw(state, playerId) {
  let s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player || !player.isAlive) return s;
  if (!player.buffs.includes("🙏")) return s;

  const count = (player._prayerCount || 0) + 1;
  if (count >= 2) {
    const { drawCards } = require("./deckManager");
    s = drawCards(s, playerId, 1);
    // drawCards 返回新 state，重新获取 player 引用
    const refreshed = s.players.find((p) => p.id === playerId);
    if (refreshed) refreshed._prayerCount = 0;
    s.gameLogs = s.gameLogs || [];
    s.gameLogs.push(`🙏 祈祷触发：抽1张牌`);
  } else {
    player._prayerCount = count;
  }
  return s;
}

function setCurseCaster(state, targetId, casterId) {
  const s = deepClone(state);
  s._curseCasterId = casterId;
  return s;
}

function clearPersistentBuffsAfterDeath(state, playerId) {
  const s = deepClone(state);
  const deadPlayer = s.players.find((p) => p.id === playerId);
  if (deadPlayer) {
    deadPlayer.buffs = [];
    deadPlayer.beastForm = null;
    deadPlayer.wolfBuff = false;
    deadPlayer._prayerCount = 0;
  }
  return s;
}

module.exports = {
  BUFF_DEFS,
  addBuff,
  removeBuff,
  onTurnStart,
  onTurnEnd,
  onCardPlayed,
  checkPrayerDraw,
  setCurseCaster,
  clearPersistentBuffsAfterDeath,
};
