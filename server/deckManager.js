/**
 * DeckManager - 牌库工具模块
 * 功能：抽牌、洗牌、弃牌、牌库耗尽自动洗弃牌堆
 * 禁止业务代码直接操作 deck[] 数组
 */

const { deepClone, shuffle } = require("./util");
const CARDS = require("./cards.json");

/** 手牌上限 */
const MAX_HAND_SIZE = 10;

/**
 * 根据角色ID获取该角色的全部卡牌ID列表
 */
function getCharacterDeckCardIds(characterId) {
  const ids = [];
  for (const [id, card] of Object.entries(CARDS)) {
    if (card.character === characterId) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 初始化玩家牌库（按角色生成牌组、洗牌）
 */
function initDeck(characterId) {
  const cardIds = getCharacterDeckCardIds(characterId);
  return {
    deck: shuffle(cardIds),
    discardPile: [],
    hand: [],
  };
}

/**
 * 抽指定数量的牌
 * 牌库空时自动洗弃牌堆→新牌库
 * 超过手牌上限时丢弃
 * 新抽的牌标记 isNewThisTurn = true（本回合可用）
 */
function drawCards(state, playerId, count = 1) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;

  for (let i = 0; i < count; i++) {
    // 牌库空 → 洗弃牌堆
    if (player.deck.length === 0) {
      if (player.discardPile.length === 0) {
        // 完全没有牌可抽，静默处理
        break;
      }
      player.deck = shuffle(player.discardPile);
      player.discardPile = [];
    }

    const cardId = player.deck.pop();

    // 手牌上限检查
    if (player.hand.length >= MAX_HAND_SIZE) {
      // 超出上限直接弃掉
      player.discardPile.push(cardId);
      continue;
    }

    player.hand.push(cardId);
  }

  return s;
}

/**
 * 弃掉手牌中的某张牌（加入弃牌堆顶部）
 */
function discardCard(state, playerId, cardId) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;

  const idx = player.hand.indexOf(cardId);
  if (idx === -1) return s;

  player.hand.splice(idx, 1);
  player.discardPile.push(cardId);

  return s;
}

/**
 * 洗入指定卡牌到牌库（随机位置）
 */
function shuffleCardIntoDeck(state, playerId, cardId) {
  const s = deepClone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) return s;

  const pos = Math.floor(Math.random() * (player.deck.length + 1));
  player.deck.splice(pos, 0, cardId);
  return s;
}

module.exports = {
  initDeck,
  drawCards,
  discardCard,
  shuffleCardIntoDeck,
  getCharacterDeckCardIds,
  MAX_HAND_SIZE,
};
