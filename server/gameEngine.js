/**
 * GameEngine - 卡牌核心结算引擎
 *
 * 伤害结算优先级（严格顺序）：
 *   1. 🫥 刺客隐身 → 完全免疫
 *   2. 真实伤害 → 跳过护盾
 *   3. 🔰 绿盾反伤 → 抵消1层 + 反弹1点真实伤害
 *   4. 🛡️ 普通护盾 → 抵消1层
 *   5. ❤️ 扣血量
 *
 * 绿盾反伤递归深度上限 10，防死循环
 */

const { deepClone } = require("./util");
const CARDS = require("./cards.json");

// ========== 玩家辅助函数 ==========

function getPlayerById(state, playerId) {
  return state.players.find((p) => p.id === playerId);
}

function updatePlayerHp(state, playerId, delta) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player || !player.isAlive) return s;
  player.hp = Math.max(0, Math.min(player.maxHp, player.hp + delta));
  return s;
}

function updatePlayerShield(state, playerId, delta) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;
  player.shield = Math.max(0, (player.shield || 0) + delta);
  return s;
}

function updatePlayerGreenShield(state, playerId, delta) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;
  player.greenShield = Math.max(0, (player.greenShield || 0) + delta);
  return s;
}

function increaseMaxHp(state, playerId, amount) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;
  player.maxHp += amount;
  player.hp = Math.min(player.hp + amount, player.maxHp);
  return s;
}

// ========== 伤害结算 ==========

/**
 * 核心伤害函数
 * 优先级：🫥免疫 → 真实伤害 → 🔰绿盾 → 🛡️普通盾 → 扣血
 * @param {number} depth 递归深度，绿盾互反保护
 */
function dealDamage(state, sourceId, targetId, damage, isTrueDamage = false, depth = 0) {
  // 递归深度保护
  if (depth > 10) return state;

  const s = deepClone(state);
  const target = s.players.find((p) => p.id === targetId);
  if (!target || !target.isAlive) return s;

  // 第一层：🫥 刺客隐身 → 完全免疫
  if (target.buffs.includes("🫥")) return s;

  // 真实伤害 → 跳过护盾，直接扣血
  if (isTrueDamage) {
    target.hp = Math.max(0, target.hp - damage);
    return s;
  }

  // 🔰 绿盾反伤护盾（逐层处理 - 每层反伤1点）
  if (target.greenShield > 0) {
    target.greenShield -= 1;
    // 非自身/非系统 → 反弹1点真实伤害
    if (sourceId !== targetId && sourceId !== "SYSTEM") {
      const source = s.players.find((p) => p.id === sourceId);
      if (source && source.isAlive) {
        // 递归反伤（真实伤害），depth+1 防止死循环
        return dealDamage(s, targetId, sourceId, 1, true, depth + 1);
      }
    }
    return s; // 伤害被绿盾完全抵消，不继续扣普通盾和血
  }

  // 🛡️ 普通护盾
  if ((target.shield || 0) > 0) {
    target.shield -= 1;
    return s;
  }

  // ❤️ 扣血
  target.hp = Math.max(0, target.hp - damage);
  return s;
}

/**
 * 多目标伤害（AOE）
 * 兽人变身被动、全体伤害统一过滤自身
 */
function dealDamageMultiTarget(state, sourceId, targetList, damage, isTrueDamage) {
  let s = state;
  const targets = targetList.filter((t) => t !== sourceId); // 过滤自身
  for (const tid of targets) {
    s = dealDamage(s, sourceId, tid, damage, isTrueDamage, 0);
  }
  return s;
}

// ========== 角色定义 ==========

const CHARACTERS = {
  "战士": { id: "战士", maxHp: 10, color: "#e74c3c", emoji: "⚔️" },
  "牧师": { id: "牧师", maxHp: 10, color: "#f1c40f", emoji: "✨" },
  "法师": { id: "法师", maxHp: 10, color: "#3498db", emoji: "🧙" },
  "坦克": { id: "坦克", maxHp: 10, color: "#2ecc71", emoji: "🛡️" },
  "兽人": { id: "兽人", maxHp: 10, color: "#e67e22", emoji: "🐺" },
  "刺客": { id: "刺客", maxHp: 10, color: "#9b59b6", emoji: "🗡️" },
};

// ========== 效果处理器映射表 ==========

const EffectHandlers = {
  // ===== 基础图标 =====
  "🗡️": (state, sourceId, targetList) => {
    if (!targetList || targetList.length === 0) return state;
    return dealDamage(state, sourceId, targetList[0], 1, false, 0);
  },
  "❤️": (state, sourceId) => healSelf(state, sourceId, 1),
  "🛡️": (state, sourceId) => addShield(state, sourceId, 1),
  "⚡":  (state, sourceId) => state, // 由 applySingleCard 处理连锁逻辑
  "🃏": (state, sourceId) => {
    const { drawCards } = require("./deckManager");
    return drawCards(state, sourceId, 1);
  },

  // ===== 战士专属 =====
  "🩸": (state, sourceId) => {
    const { addBuff } = require("./buffManager");
    return addBuff(state, sourceId, "🩸");
  },

  // ===== 牧师专属 =====
  "💕": (state, sourceId) => increaseMaxHp(state, sourceId, 1),
  "♻️": (state, sourceId, targetList) => {
    if (!targetList || targetList.length === 0) return state;
    return swapHp(state, sourceId, targetList[0]);
  },

  // ===== 法师专属 =====
  "⛈️": (state, sourceId, targetList) => {
    if (!targetList || targetList.length === 0) return state;
    const { addBuff, setCurseCaster } = require("./buffManager");
    let s = addBuff(state, targetList[0], "⛈️");
    s = setCurseCaster(s, targetList[0], sourceId);
    s.gameLogs = s.gameLogs || [];
    s.gameLogs.push(`⛈️ 雷暴诅咒施加于目标，持续至施法者下回合开始`);
    return s;
  },
  "🙏": (state, sourceId) => {
    const { addBuff } = require("./buffManager");
    let s = addBuff(state, sourceId, "🙏");
    const player = s.players.find((p) => p.id === sourceId);
    if (player) player._prayerCount = 0;
    return s;
  },

  // ===== 坦克专属 =====
  "💥": (state, sourceId) => clearAllShields(state, sourceId),
  "🔰": (state, sourceId) => addGreenShield(state, sourceId, 1),

  // ===== 兽人专属 =====
  "🐾": (state, sourceId) => triggerBeastFormPassive(state, sourceId),
  "🐻": (state, sourceId) => setBeastForm(state, sourceId, "bear"),
  "🐺": (state, sourceId) => setBeastForm(state, sourceId, "wolf"),
  "🐯": (state, sourceId) => setBeastForm(state, sourceId, "tiger"),

  // ===== 刺客专属 =====
  "👀": (state, sourceId, targetList) => {
    if (!targetList || targetList.length === 0) return state;
    return swapHandCards(state, sourceId, targetList[0]);
  },
  "🫥": (state, sourceId) => {
    const { addBuff } = require("./buffManager");
    return addBuff(state, sourceId, "🫥");
  },
};

// ===== 效果实现函数 =====

function healSelf(state, playerId, amount) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player || !player.isAlive) return s;
  player.hp = Math.min(player.maxHp, player.hp + amount);
  return s;
}

function addShield(state, playerId, amount) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;
  player.shield = (player.shield || 0) + amount;
  return s;
}

function addGreenShield(state, playerId, amount) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;
  player.greenShield = (player.greenShield || 0) + amount;
  return s;
}

function clearAllShields(state, sourceId) {
  const s = deepClone(state);
  // 清除所有存活的"其他玩家"的普通护盾（不包括自己）
  for (const player of s.players) {
    if (player.id !== sourceId && player.isAlive) {
      player.shield = 0;
    }
  }
  return s;
}

function swapHp(state, sourceId, targetId) {
  const s = deepClone(state);
  const src = s.players.find((p) => p.id === sourceId);
  const tgt = s.players.find((p) => p.id === targetId);
  if (!src || !tgt || !src.isAlive || !tgt.isAlive) return s;
  const srcHp = src.hp;
  src.hp = Math.min(src.maxHp, tgt.hp);
  tgt.hp = Math.min(tgt.maxHp, srcHp);
  return s;
}

function swapHandCards(state, sourceId, targetId) {
  const s = deepClone(state);
  const src = s.players.find((p) => p.id === sourceId);
  const tgt = s.players.find((p) => p.id === targetId);
  if (!src || !tgt || !src.isAlive || !tgt.isAlive) return s;
  if (tgt.hand.length === 0) return s; // 对手无手牌，窥视无效

  s._peekedHand = [...tgt.hand];
  s._peekTargetId = targetId;
  s._pendingStealPick = true;
  s._giftSourceId = sourceId;
  s._giftTargetId = targetId;

  return s;
}

/**
 * 第一步：从对手手牌中选一张偷过来
 */
function resolveStealPick(state, chosenCardId) {
  const s = deepClone(state);
  const src = s.players.find((p) => p.id === s._giftSourceId);
  const tgt = s.players.find((p) => p.id === s._giftTargetId);
  if (!src || !tgt) return s;

  const idx = tgt.hand.indexOf(chosenCardId);
  if (idx === -1) return s;

  // 偷取
  tgt.hand.splice(idx, 1);
  src.hand.push(chosenCardId);

  // 进入第二步：从自己手牌选一张还回去
  s._pendingStealPick = false;
  s._pendingGiftPick = true;

  return s;
}

/**
 * 第二步：从自己手牌选一张还给对手
 */
function resolveGiftPick(state, chosenCardId) {
  const s = deepClone(state);
  const src = s.players.find((p) => p.id === s._giftSourceId);
  const tgt = s.players.find((p) => p.id === s._giftTargetId);
  if (!src || !tgt) return s;

  const idx = src.hand.indexOf(chosenCardId);
  if (idx === -1) return s;

  src.hand.splice(idx, 1);
  tgt.hand.push(chosenCardId);

  // 清除所有标记
  s._peekedHand = null;
  s._peekTargetId = null;
  s._pendingStealPick = false;
  s._pendingGiftPick = false;
  s._giftSourceId = null;
  s._giftTargetId = null;

  return s;
}

function setBeastForm(state, playerId, form) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;
  player.beastForm = form;
  return s;
}

function triggerBeastFormPassive(state, playerId) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player || !player.beastForm || !player.isAlive) return s;

  // 根据当前形态触发被动
  switch (player.beastForm) {
    case "bear":
      // 熊形态被动：获得1点治疗
      player.hp = Math.min(player.maxHp, player.hp + 1);
      break;
    case "wolf":
      // 狼形态被动：对左右邻位各造成1点普通伤害
      {
        const alivePlayers = s.players
          .filter((p) => p.isAlive)
          .sort((a, b) => a.seatIndex - b.seatIndex);
        const myIdx = alivePlayers.findIndex((p) => p.id === playerId);
        if (myIdx !== -1) {
          const leftIdx = (myIdx - 1 + alivePlayers.length) % alivePlayers.length;
          const rightIdx = (myIdx + 1) % alivePlayers.length;
          const targets = [];
          if (leftIdx !== myIdx) targets.push(alivePlayers[leftIdx].id);
          if (rightIdx !== myIdx && rightIdx !== leftIdx) targets.push(alivePlayers[rightIdx].id);
          for (const tid of targets) {
            s.players = dealDamage(s, playerId, tid, 1, false, 0).players;
          }
        }
      }
      break;
    case "tiger":
      // 虎形态被动：对所有敌人造成3点无视护盾的真实伤害
      {
        const enemies = s.players.filter((p) => p.id !== playerId && p.isAlive);
        for (const enemy of enemies) {
          s.players = dealDamage(s, playerId, enemy.id, 3, true, 0).players;
        }
      }
      break;
  }
  return s;
}

// ========== 目标获取 ==========

/**
 * 根据效果类型获取目标
 * 🗡️/♻️/⛈️/👀 需要指定目标
 * ❤️/🛡️/🃏/🩸/💕/🙏/💥/🔰/🐾/🐻/🐺/🐯/🫥 为自身效果
 */
function getTargetForEffect(targetList, effect, effectIndex) {
  const selfOnlyEffects = ["❤️", "🛡️", "🃏", "🩸", "💕", "🙏", "💥", "🔰", "🐾", "🐻", "🐺", "🐯", "🫥"];
  if (selfOnlyEffects.includes(effect)) return [];

  // 需要目标的效果：从targetList按顺序取
  if (targetList && targetList.length > 0) {
    // 简单处理：取第一个有效目标
    return [targetList[0]];
  }
  return [];
}

// ========== 卡牌结算核心 ==========

/**
 * 获取卡牌信息
 */
function getCardById(cardId) {
  return CARDS[cardId] || null;
}

/**
 * applySingleCard - 单张卡牌全部效果结算
 */
function applySingleCard(state, action) {
  let tempState = deepClone(state);
  const card = getCardById(action.cardId);
  if (!card) return tempState;

  // 卡牌图标从左至右依次执行
  for (let i = 0; i < card.effects.length; i++) {
    const effect = card.effects[i];

    // 🃏 抽牌：立即执行，不等待整张牌结算完
    if (effect === "🃏") {
      const { drawCards } = require("./deckManager");
      tempState = drawCards(tempState, action.sourceId, 1);
      continue;
    }

    // ⚡ 闪电：不在这里处理，由CardEngine.resolve处理连锁
    if (effect === "⚡") continue;

    // 其他效果通过映射表执行
    if (EffectHandlers[effect]) {
      const targetForThisEffect = getTargetForEffect(action.targets, effect, i);
      tempState = EffectHandlers[effect](tempState, action.sourceId, targetForThisEffect);
    }
  }

  // 单张卡牌全部结算后，将卡牌移入弃牌堆
  const { discardCard } = require("./deckManager");
  tempState = discardCard(tempState, action.sourceId, action.cardId);

  // 手牌清空 → 立马补两张牌
  const playerAfter = getPlayerById(tempState, action.sourceId);
  if (playerAfter && playerAfter.isAlive && playerAfter.hand.length === 0) {
    const { drawCards } = require("./deckManager");
    tempState = drawCards(tempState, action.sourceId, 2);
  }

  // 🙏 祈祷计数：每出两张牌抽一张
  const { checkPrayerDraw } = require("./buffManager");
  tempState = checkPrayerDraw(tempState, action.sourceId);

  // 消耗一次出牌权；每个⚡+1次出牌权
  tempState._playsRemaining = (tempState._playsRemaining || 0) - 1;
  const boltCount = card.effects.filter(e => e === "⚡").length;
  tempState._playsRemaining += boltCount;
  tempState._hasPlayed = true;

  // 还有出牌权且有手牌 → 进入连锁等待
  if (tempState._playsRemaining > 0) {
    const player = getPlayerById(tempState, action.sourceId);
    if (player && player.isAlive && player.hand.length > 0) {
      tempState.awaitingChain = true;
      tempState.chainPlayerId = action.sourceId;
    }
  }

  return tempState;
}

/**
 * CardEngine.resolve - 结算队列核心逻辑
 * 所有卡牌、连锁效果统一进入队列串行结算
 */
function resolve(gameState, playerId, cardId, targets) {
  // 初始化结算队列
  let queue = [{ sourceId: playerId, cardId, targets, isChain: false }];
  let currentState = deepClone(gameState);
  currentState.awaitingChain = false;
  currentState.chainPlayerId = "";
  currentState._playsRemaining = 1; // 本回合基础出牌权

  while (queue.length > 0) {
    const action = queue.shift();
    // 执行单张卡牌结算
    currentState = applySingleCard(currentState, action);

    // 如果触发了连锁，等待客户端CHAIN_CONTINUE指令
    if (currentState.awaitingChain) {
      break; // 中断队列，等待玩家连锁选择
    }
  }

  // 队列全部结算完成，统一判定玩家死亡
  currentState = checkAndRemoveDeadPlayers(currentState);

  return currentState;
}

/**
 * 处理连锁继续出牌
 */
function resolveChain(state, playerId, cardId, targets) {
  let currentState = deepClone(state);
  currentState.awaitingChain = false;
  currentState.chainPlayerId = "";

  // 执行连锁卡牌
  currentState = applySingleCard(currentState, {
    sourceId: playerId,
    cardId,
    targets,
    isChain: true,
  });

  // 连锁后还可能再触发连锁
  if (!currentState.awaitingChain) {
    currentState = checkAndRemoveDeadPlayers(currentState);
  }

  return currentState;
}

/**
 * 放弃连锁
 */
function skipChain(state) {
  let s = deepClone(state);
  s.awaitingChain = false;
  s.chainPlayerId = "";
  s._playsRemaining = 0; // 放弃连锁，出牌权清零
  s = checkAndRemoveDeadPlayers(s);
  return s;
}

/**
 * 统一检查并移除死亡玩家
 * 在全部结算完成后调用，避免数组遍历错位
 */
function checkAndRemoveDeadPlayers(state) {
  const s = deepClone(state);
  for (const player of s.players) {
    if (player.hp <= 0 && player.isAlive) {
      player.isAlive = false;
      // 清除死亡玩家的Buff
      player.buffs = [];
      player.beastForm = null;
      player.wolfBuff = false;
    }
  }
  return s;
}

/**
 * 检查胜利条件：仅1名存活玩家
 */
function checkWinCondition(state) {
  const alive = state.players.filter((p) => p.isAlive);
  if (alive.length <= 1) {
    return {
      gameOver: true,
      winner: alive.length === 1 ? alive[0] : null,
    };
  }
  return { gameOver: false, winner: null };
}

/**
 * 获取下一个存活玩家
 */
function getNextAlivePlayer(state, currentSeatIndex) {
  const alive = state.players.filter((p) => p.isAlive).sort((a, b) => a.seatIndex - b.seatIndex);
  // 找到当前座位之后的下一个存活玩家
  const next = alive.find((p) => p.seatIndex > currentSeatIndex);
  if (next) return next;
  // 循环回到开头
  return alive[0] || null;
}

/**
 * 创建初始游戏状态
 */
function createInitialGameState(roomId, players) {
  const { initDeck } = require("./deckManager");

  const gamePlayers = players.map((p) => {
    const charInfo = CHARACTERS[p.character] || CHARACTERS["战士"];
    const deckData = initDeck(p.character);
    return {
      id: p.id,
      seatIndex: p.seatIndex,
      character: p.character,
      hp: charInfo.maxHp,
      maxHp: charInfo.maxHp,
      shield: 0,
      greenShield: 0,
      hand: [],
      deck: deckData.deck,
      discardPile: [],
      buffs: [],
      beastForm: null,
      wolfBuff: false,
      isAlive: true,
      connected: true,
    };
  });

  return {
    roomId,
    players: gamePlayers,
    currentPlayerIndex: 0,
    turnOrder: gamePlayers.map((p) => p.id),
    phase: "DEALING",
    awaitingChain: false,
    chainPlayerId: "",
    _playsRemaining: 1,
    turnCount: 0,
    gameLogs: [],
  };
}

module.exports = {
  // 核心结算
  resolve,
  resolveChain,
  skipChain,
  applySingleCard,
  resolveGiftPick,
  resolveStealPick,
  dealDamage,
  dealDamageMultiTarget,

  // 状态管理
  checkAndRemoveDeadPlayers,
  checkWinCondition,
  getNextAlivePlayer,
  createInitialGameState,

  // 工具
  getPlayerById,
  getCardById,
  getTargetForEffect,

  // 常量
  CHARACTERS,
  EffectHandlers,
};
