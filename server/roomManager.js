/**
 * RoomManager - 房间管理模块
 *
 * 房间状态机：
 *   WAITING → ROLLING → PICKING → DEALING → PLAYING → GAME_OVER
 *
 * 超时机制：
 *   选角 30s | 出牌 60s | 闪电连锁 15s | 断线托管 90s
 */

const { generateRoomCode, deepClone, shuffle } = require("./util");
const { CHARACTERS, createInitialGameState, resolve, resolveChain, skipChain, checkWinCondition, getNextAlivePlayer, resolveStealPick, resolveGiftPick } = require("./gameEngine");
const { drawCards } = require("./deckManager");
const CARDS = require("./cards.json");

/** 生成战斗日志：卡牌名 + 图标 + 目标，如 "猛击 🗡️x2 → 法师" */
function formatCardPlayLog(cardId, gameState, targets) {
  const card = CARDS[cardId];
  if (!card) return cardId;
  const counts = {};
  for (const e of (card.effects || [])) counts[e] = (counts[e] || 0) + 1;
  const order = ['🗡️','🛡️','❤️','🃏','⚡','🔰','💥','🩸','💕','♻️','⛈️','🙏','🐾','🐻','🐺','🐯','👀','🫥'];
  const iconStr = order.filter(o => counts[o]).map(o => counts[o] > 1 ? `${o}x${counts[o]}` : o).join(' ') || '';
  // 目标信息
  let targetStr = '';
  if (targets && targets.length > 0 && gameState) {
    const names = targets.map(tid => {
      const tp = (gameState.players || []).find(p => p.id === tid);
      return tp ? tp.character : tid;
    }).filter(Boolean);
    if (names.length > 0) targetStr = ' → ' + names.join('、');
  }
  return `${card.name} ${iconStr}${targetStr}`;
}
const { onTurnStart, onTurnEnd } = require("./buffManager");

// ========== 超时配置 (ms) ==========
const TIMEOUTS = {
  PICK_CHARACTER: 30000,
  PLAY_CARD: 110000,
  CHAIN: 15000,
  DISCONNECT: 90000,
  GAME_OVER: 90000,
  HEARTBEAT: 5000,
  HEARTBEAT_MAX_MISS: 3,
};

class Room {
  constructor(code) {
    this.code = code;
    this.phase = "WAITING"; // WAITING | ROLLING | PICKING | DEALING | PLAYING | GAME_OVER
    this.players = [];       // { id, seatIndex, nickname, character, ws, connected, diceRoll }
    this.maxPlayers = 4;
    this.gameState = null;   // GameState 对象
    this.hostSeatIndex = 0;  // 房主座位
    this.pickOrder = [];     // 掷骰后的选角顺序
    this.pickIndex = 0;      // 当前选角序号
    this.timers = {};        // 各阶段定时器
    this.heartbeatMisses = {}; // playerId → miss count
    this.createdAt = Date.now();
  }

  // ===== 玩家管理 =====

  addPlayer(ws, nickname) {
    if (this.players.length >= this.maxPlayers) return { error: "ROOM_FULL" };
    if (this.phase !== "WAITING") return { error: "ROOM_ALREADY_STARTED" };

    // 检查该连接是否已在房间中（防止重复加入产生幽灵玩家）
    const existing = this.players.find(p => p.ws === ws);
    if (existing) {
      existing.nickname = nickname || existing.nickname; // 更新昵称
      return { success: true, player: existing, alreadyJoined: true };
    }

    const { generatePlayerId } = require("./util");
    const player = {
      id: generatePlayerId(),
      seatIndex: this.players.length,
      nickname: nickname || "Player",
      character: null,
      ws: ws,
      connected: true,
      diceRoll: 0,
    };
    this.players.push(player);
    this.heartbeatMisses[player.id] = 0;
    return { success: true, player };
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return;
    this.players.splice(idx, 1);
    delete this.heartbeatMisses[playerId];
    // 重新分配座位
    this.players.forEach((p, i) => (p.seatIndex = i));
  }

  getPlayer(playerId) {
    return this.players.find((p) => p.id === playerId);
  }

  getPlayerByWs(ws) {
    return this.players.find((p) => p.ws === ws);
  }

  // ===== 断线/重连 =====

  handleDisconnect(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return;
    player.connected = false;

    // 房主在游戏开始前退出 → 房间自动解散
    if (player.seatIndex === this.hostSeatIndex && (this.phase === "WAITING" || this.phase === "ROLLING" || this.phase === "PICKING")) {
      const { roomManager } = require("./roomManager");
      // 通知其他玩家房间解散
      for (const p of this.players) {
        if (p.ws && p.connected && p.id !== playerId) {
          try { require("./messageHandler").send(p.ws, "ROOM_DISMISSED", { msg: "房主已退出，房间解散" }); } catch (_) {}
        }
      }
      roomManager.destroyRoom(this.code);
      return;
    }

    // 如果在对局中，标记但不立即移除
    if (this.phase === "PLAYING" || this.phase === "PICKING") {
      // 90秒后自动托管
      this.timers["disconnect_" + playerId] = setTimeout(() => {
        this.handleAbandon(playerId);
      }, TIMEOUTS.DISCONNECT);
    } else {
      this.removePlayer(playerId);
    }
  }

  handleReconnect(ws, playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return { error: "PLAYER_NOT_FOUND" };
    player.ws = ws;
    player.connected = true;
    this.heartbeatMisses[playerId] = 0;
    // 清除断线托管定时器
    if (this.timers["disconnect_" + playerId]) {
      clearTimeout(this.timers["disconnect_" + playerId]);
      delete this.timers["disconnect_" + playerId];
    }
    return { success: true, player };
  }

  handleAbandon(playerId) {
    // 超时弃权：标记死亡
    if (this.gameState) {
      const gsPlayer = this.gameState.players.find((p) => p.id === playerId);
      if (gsPlayer) {
        gsPlayer.isAlive = false;
        gsPlayer.connected = false;
      }
    }
    const player = this.getPlayer(playerId);
    if (player) player.connected = false;

    // 检查是否游戏结束
    if (this.gameState) {
      const result = checkWinCondition(this.gameState);
      if (result.gameOver) this.endGame(result.winner);
    }
  }

  // ===== 心跳 =====

  handlePing(playerId) {
    this.heartbeatMisses[playerId] = 0;
  }

  checkHeartbeats() {
    for (const player of this.players) {
      if (!player.connected) continue;
      this.heartbeatMisses[player.id] = (this.heartbeatMisses[player.id] || 0) + 1;
      if (this.heartbeatMisses[player.id] >= TIMEOUTS.HEARTBEAT_MAX_MISS) {
        this.handleDisconnect(player.id);
      }
    }
  }

  // ===== 掷骰选角 =====

  rollDice() {
    if (this.phase !== "WAITING") return { error: "ROOM_ALREADY_STARTED" };
    if (this.players.length < 2) return { error: "PLAYER_NOT_READY", msg: "至少需要2名玩家" };

    this.phase = "ROLLING";

    // 每人掷骰
    for (const player of this.players) {
      player.diceRoll = Math.floor(Math.random() * 6) + 1;
    }

    // 按点数降序排列选角顺序
    this.pickOrder = [...this.players]
      .sort((a, b) => b.diceRoll - a.diceRoll || a.seatIndex - b.seatIndex)
      .map((p) => p.id);
    this.pickIndex = 0;

    // 进入选角阶段
    this.phase = "PICKING";
    return {
      success: true,
      rolls: this.players.map((p) => ({
        playerId: p.id,
        nickname: p.nickname,
        seatIndex: p.seatIndex,
        diceRoll: p.diceRoll,
      })),
      pickOrder: [...this.pickOrder],
    };
  }

  pickCharacter(playerId, characterId) {
    if (this.phase !== "PICKING") return { error: "NOT_PICKING_PHASE" };
    if (this.pickOrder[this.pickIndex] !== playerId) return { error: "NOT_YOUR_PICK_TURN" };
    if (!CHARACTERS[characterId]) return { error: "INVALID_CHARACTER" };

    // 检查角色是否已被选
    const alreadyPicked = this.players.find(
      (p) => p.character === characterId && p.id !== playerId
    );
    if (alreadyPicked) return { error: "CHARACTER_ALREADY_PICKED" };

    const player = this.getPlayer(playerId);
    if (!player) return { error: "PLAYER_NOT_FOUND" };
    player.character = characterId;
    this.pickIndex++;

    // 所有人选完 → 发牌阶段
    if (this.pickIndex >= this.players.length) {
      return this.startDealing();
    }

    return { success: true, nextPicker: this.pickOrder[this.pickIndex] };
  }

  autoPickRemaining() {
    const availableChars = Object.keys(CHARACTERS).filter(
      (c) => !this.players.some((p) => p.character === c)
    );
    for (const player of this.players) {
      if (!player.character) {
        const idx = Math.floor(Math.random() * availableChars.length);
        player.character = availableChars.splice(idx, 1)[0];
      }
    }
    return this.startDealing();
  }

  // ===== 发牌 & 开局 =====

  startDealing() {
    this.phase = "DEALING";
    this.gameState = createInitialGameState(this.code, this.players);
    this.gameState.phase = "DEALING";

    // 每人发初始 3 张手牌
    for (let i = 0; i < 3; i++) {
      for (const player of this.players) {
        this.gameState = drawCards(this.gameState, player.id, 1);
      }
    }

    const alivePlayers = this.gameState.players
      .filter((p) => p.isAlive)
      .sort((a, b) => a.seatIndex - b.seatIndex);
    this.gameState.turnOrder = alivePlayers.map((p) => p.id);
    this.gameState.currentPlayerIndex = 0;

    // 首回合不额外抽牌
    this.phase = "PLAYING";
    this.gameState.phase = "PLAYING";
    this.gameState.turnCount = 1;
    this.gameState.gameLogs.push("🏁 游戏开始！");

    const firstPlayerId = this.gameState.turnOrder[0];
    this.gameState = onTurnStart(this.gameState, firstPlayerId);

    return { success: true, phase: "PLAYING" };
  }

  // ===== 出牌 =====

  playCard(playerId, cardId, targets) {
    if (this.phase !== "PLAYING") return { error: "ROOM_ALREADY_STARTED" };
    const gs = this.gameState;
    if (!gs) return { error: "SERVER_ERROR" };

    // 刺客换牌中，禁止普通出牌
    if (gs._pendingStealPick || gs._pendingGiftPick) {
      return { error: "INVALID_REQUEST", msg: "请先完成换牌选择" };
    }

    const currentPlayerId = gs.turnOrder[gs.currentPlayerIndex];
    if (currentPlayerId !== playerId) return { error: "NOT_YOUR_TURN" };

    // 如果是连锁等待状态，只能由连锁玩家出牌
    if (gs.awaitingChain && gs.chainPlayerId !== playerId) {
      return { error: "NOT_YOUR_TURN", msg: "等待其他玩家连锁" };
    }

    // 出牌权检查
    const pr = gs._playsRemaining || 0;
    if (pr <= 0 && !gs._pendingStealPick && !gs._pendingGiftPick) {
      return { error: "INVALID_REQUEST", msg: "本回合出牌次数已用完" };
    }

    const player = gs.players.find((p) => p.id === playerId);
    if (!player || !player.isAlive) return { error: "PLAYER_NOT_ALIVE" };
    if (!player.hand.includes(cardId)) return { error: "INVALID_CARD" };

    // 验证目标合法性 & 将 seatIndex 转换为 playerId
    const resolvedTargets = [];
    if (targets && targets.length > 0) {
      for (const t of targets) {
        const targetPlayer = gs.players.find((p) => p.seatIndex === t && p.isAlive);
        if (!targetPlayer) return { error: "TARGET_NOT_ALIVE" };
        resolvedTargets.push(targetPlayer.id);
      }
    }

    let isChainCard = false;
    if (gs.awaitingChain) {
      // 连锁出牌
      this.gameState = resolveChain(gs, playerId, cardId, resolvedTargets);
      this.gameState.gameLogs.push(
        "⚡ " + player.character + " " + formatCardPlayLog(cardId, this.gameState, resolvedTargets)
      );
      isChainCard = true;
    } else {
      // 正常出牌
      this.gameState = resolve(gs, playerId, cardId, resolvedTargets);
      this.gameState.gameLogs.push(
        "🎴 " + player.character + " " + formatCardPlayLog(cardId, this.gameState, resolvedTargets)
      );
    }

    // 检查胜利条件
    const result = checkWinCondition(this.gameState);
    if (result.gameOver) {
      this.endGame(result.winner);
      return { success: true, gameOver: true, winner: result.winner };
    }

    return { success: true, awaitingChain: this.gameState.awaitingChain };
  }

  // ===== 连锁继续/停止 =====

  chainContinue(playerId, wantContinue, cardId, targets) {
    if (!this.gameState || !this.gameState.awaitingChain) {
      return { error: "INVALID_REQUEST", msg: "不在连锁状态" };
    }
    if (this.gameState.chainPlayerId !== playerId) {
      return { error: "NOT_YOUR_TURN" };
    }

    if (wantContinue && cardId) {
      // 继续连锁 → playCard 内部会处理 auto-end-turn
      return this.playCard(playerId, cardId, targets);
    } else {
      // 放弃连锁 → 所有效果结束，自动推进回合
      this.gameState = skipChain(this.gameState);
      this.gameState.gameLogs.push("⏭️ 放弃连锁");

      const result = checkWinCondition(this.gameState);
      if (result.gameOver) {
        this.endGame(result.winner);
        return { success: true, gameOver: true, winner: result.winner };
      }

      return { success: true };
    }
  }

  // ===== 刺客换牌第一步：选牌偷取 =====
  pickStealCard(playerId, cardId) {
    if (!this.gameState) return { error: "SERVER_ERROR" };
    const gs = this.gameState;
    if (!gs._pendingStealPick) return { error: "INVALID_REQUEST", msg: "不在偷牌阶段" };
    if (gs._giftSourceId !== playerId) return { error: "NOT_YOUR_TURN" };

    // 验证卡牌在对方手中
    const tgt = gs.players.find((p) => p.id === gs._giftTargetId);
    if (!tgt || !tgt.hand.includes(cardId)) return { error: "INVALID_CARD" };

    // 执行偷取
    this.gameState = resolveStealPick(gs, cardId);
    this.gameState.gameLogs.push("👀 窥视：偷取 1 张牌，等待选牌归还");
    return { success: true, phase: "gift" };
  }

  // ===== 刺客换牌第二步：选牌回赠 =====
  pickGiftCard(playerId, cardId) {
    if (!this.gameState) return { error: "SERVER_ERROR" };
    const gs = this.gameState;
    if (!gs._pendingGiftPick) return { error: "INVALID_REQUEST", msg: "不在还牌阶段" };
    if (gs._giftSourceId !== playerId) return { error: "NOT_YOUR_TURN" };

    // 验证卡牌在施法者手中（含刚偷来的）
    const player = gs.players.find((p) => p.id === playerId);
    if (!player || !player.hand.includes(cardId)) return { error: "INVALID_CARD" };

    // 执行回赠
    this.gameState = resolveGiftPick(gs, cardId);
    this.gameState.gameLogs.push("👀 窥视完成：交还 1 张牌");

    // 检查胜利条件
    const result = checkWinCondition(this.gameState);
    if (result.gameOver) {
      this.endGame(result.winner);
      return { success: true, gameOver: true, winner: result.winner };
    }

    return { success: true };
  }

  // ===== 结束回合 =====

  endTurn(playerId) {
    if (this.phase !== "PLAYING") return { error: "ROOM_ALREADY_STARTED" };
    const gs = this.gameState;
    if (!gs) return { error: "SERVER_ERROR" };

    const currentPlayerId = gs.turnOrder[gs.currentPlayerIndex];
    if (currentPlayerId !== playerId) return { error: "NOT_YOUR_TURN" };
    if (gs.awaitingChain) return { error: "INVALID_REQUEST", msg: "请先处理连锁" };
    if (gs._pendingStealPick || gs._pendingGiftPick) return { error: "INVALID_REQUEST", msg: "请先完成换牌选择" };
    // 未出牌 → 自动随机出一张
    if (!gs._hasPlayed) {
      return this._forcePlayCard(playerId);
    }

    // 回合结束处理
    this.gameState = onTurnEnd(this.gameState, currentPlayerId);

    // 检查胜利条件
    let result = checkWinCondition(this.gameState);
    if (result.gameOver) {
      this.endGame(result.winner);
      return { success: true, gameOver: true, winner: result.winner };
    }

    // 下一个存活玩家
    const currentPlayer = gs.players.find((p) => p.id === currentPlayerId);
    if (currentPlayer) {
      const nextPlayer = getNextAlivePlayer(this.gameState, currentPlayer.seatIndex);
      if (nextPlayer) {
        const nextIdx = this.gameState.turnOrder.indexOf(nextPlayer.id);
        this.gameState.currentPlayerIndex = nextIdx;
        this.gameState.turnCount++;

        // 新回合开始
        this.gameState._playsRemaining = 1; // 重置出牌权
        this.gameState._hasPlayed = false; // 重置出牌标记
        // 回合开始抽1张牌
        this.gameState = drawCards(this.gameState, nextPlayer.id, 1);
        // Buff回合开始处理
        this.gameState = onTurnStart(this.gameState, nextPlayer.id);
        this.gameState.gameLogs.push(
          "🔄 轮到 " + (nextPlayer.nickname || nextPlayer.character) + " (" + nextPlayer.character + " 座位" + nextPlayer.seatIndex + ")"
        );
      }
    }

    result = checkWinCondition(this.gameState);
    if (result.gameOver) {
      this.endGame(result.winner);
      return { success: true, gameOver: true, winner: result.winner };
    }

    return { success: true };
  }

  // ===== 强制出牌（过牌时未出牌的兜底） =====
  _forcePlayCard(playerId) {
    const player = this.gameState.players.find(p => p.id === playerId);
    if (!player || !player.isAlive || player.hand.length === 0) {
      this.gameState._hasPlayed = true;
    } else {
      const CARDS = require("./cards.json");
      let cardId = player.hand.find(cid => {
        const c = CARDS[cid];
        return c && !(c.effects || []).some(e => ['🗡️','♻️','⛈️','👀'].includes(e));
      });
      if (!cardId) cardId = player.hand[0];
      const enemies = this.gameState.players.filter(p => p.id !== playerId && p.isAlive);
      const target = enemies.length > 0 ? [enemies[0].seatIndex] : [];
      const autoTargets = enemies.length > 0 ? [enemies[0].id] : [];
      this.gameState.gameLogs.push("⏩ 自动 " + formatCardPlayLog(cardId, this.gameState, autoTargets));
      const playRes = this.playCard(playerId, cardId, target);
      if (!playRes.success) return playRes;
      // 出牌触发了连锁 → 不自动过牌，等玩家操作
      if (this.gameState.awaitingChain) return { success: true, awaitingChain: true };
      // 换牌等待中 → 不自动过牌，等玩家操作
      if (this.gameState._pendingStealPick || this.gameState._pendingGiftPick) return { success: true };
    }
    // 自动过牌完成
    return this.endTurn(playerId);
  }

  // ===== 超时自动处理 =====

  handleTimeout(action) {
    if (action === "PLAY_CARD" || action === "END_TURN") {
      // 强制结束回合
      const gs = this.gameState;
      if (gs && gs.phase === "PLAYING") {
        const currentPlayerId = gs.turnOrder[gs.currentPlayerIndex];
        if (currentPlayerId && !gs.awaitingChain) {
          return this.endTurn(currentPlayerId);
        }
      }
    } else if (action === "CHAIN") {
      // 自动放弃连锁
      if (this.gameState && this.gameState.awaitingChain) {
        this.gameState = skipChain(this.gameState);
        this.gameState.gameLogs.push("⏰ 连锁超时，自动终止");
        return { success: true };
      }
    } else if (action === "PICK_CHARACTER") {
      return this.autoPickRemaining();
    }
    return { success: false };
  }

  // ===== 游戏结束 =====

  endGame(winner) {
    this.phase = "GAME_OVER";
    if (this.gameState) {
      this.gameState.phase = "GAME_OVER";
      this.gameState.gameLogs.push(
        winner
          ? "🏆 " + (winner.nickname || winner.character) + " 获胜！"
          : "🤝 平局！"
      );
    }
    // 90秒后销毁房间
    this.timers["destroy"] = setTimeout(() => {
      const { roomManager } = require("./roomManager");
      roomManager.destroyRoom(this.code);
    }, TIMEOUTS.GAME_OVER);
  }

  // ===== 序列化（发送给客户端） =====

  getPublicState() {
    if (!this.gameState) {
      return {
        roomCode: this.code,
        phase: this.phase,
        pickOrder: [...this.pickOrder],
        pickIndex: this.pickIndex,
        players: this.players.map((p) => ({
          id: p.id,
          seatIndex: p.seatIndex,
          nickname: p.nickname,
          character: p.character,
          connected: p.connected,
          diceRoll: p.diceRoll,
        })),
      };
    }

    return {
      roomCode: this.code,
      phase: this.phase,
      players: this.gameState.players.map((p) => ({
        id: p.id,
        seatIndex: p.seatIndex,
        nickname: p.nickname || "",
        character: p.character,
        hp: p.hp,
        maxHp: p.maxHp,
        shield: p.shield,
        greenShield: p.greenShield,
        handCount: p.hand.length,
        deckCount: p.deck.length,
        discardCount: p.discardPile.length,
        buffs: p.buffs,
        beastForm: p.beastForm,
        wolfBuff: p.wolfBuff || false,
        isAlive: p.isAlive,
        connected: p.connected,
      })),
      currentPlayerIndex: this.gameState.currentPlayerIndex,
      turnOrder: this.gameState.turnOrder,
      awaitingChain: this.gameState.awaitingChain,
      chainPlayerId: this.gameState.chainPlayerId,
      playsRemaining: this.gameState._playsRemaining || 0,
      pendingStealPick: this.gameState._pendingStealPick || false,
      pendingGiftPick: this.gameState._pendingGiftPick || false,
      giftSourceId: this.gameState._giftSourceId || "",
      giftTargetId: this.gameState._giftTargetId || "",
      turnCount: this.gameState.turnCount,
      gameLogs: this.gameState.gameLogs.slice(-20),
    };
  }

  getPrivateState(playerId) {
    if (!this.gameState) return null;
    const player = this.gameState.players.find((p) => p.id === playerId);
    if (!player) return null;
    const priv = {
      hand: player.hand,
      deckCount: player.deck.length,
      discardPile: [...player.discardPile],
    };
    // 刺客窥视 step1：展示对方手牌供偷取
    if (this.gameState._pendingStealPick && this.gameState._giftSourceId === playerId) {
      priv.peekedHand = this.gameState._peekedHand || [];
      priv.peekTargetId = this.gameState._giftTargetId;
    }
    // 刺客窥视 step2：展示自己手牌供归还
    if (this.gameState._pendingGiftPick && this.gameState._giftSourceId === playerId) {
      priv.giftPickMode = true;
      priv.giftTargetId = this.gameState._giftTargetId;
    }
    return priv;
  }
}

// ========== 全局房间管理器 ==========

class RoomManager {
  constructor() {
    this.rooms = {}; // roomCode → Room
    this.playerRoomMap = {}; // playerId → roomCode
  }

  createRoom() {
    const code = generateRoomCode();
    // 避免重复
    if (this.rooms[code]) return this.createRoom();
    const room = new Room(code);
    this.rooms[code] = room;
    return room;
  }

  getRoom(code) {
    return this.rooms[code] || null;
  }

  destroyRoom(code) {
    const room = this.rooms[code];
    if (room) {
      // 清除所有定时器
      for (const key of Object.keys(room.timers)) {
        clearTimeout(room.timers[key]);
      }
      // 解除玩家房间映射
      for (const player of room.players) {
        delete this.playerRoomMap[player.id];
      }
      delete this.rooms[code];
    }
  }

  getRoomByPlayer(playerId) {
    const code = this.playerRoomMap[playerId];
    return code ? this.rooms[code] : null;
  }

  mapPlayerToRoom(playerId, roomCode) {
    this.playerRoomMap[playerId] = roomCode;
  }

  // 定时心跳检查
  startHeartbeatLoop() {
    setInterval(() => {
      for (const room of Object.values(this.rooms)) {
        room.checkHeartbeats();
      }
    }, TIMEOUTS.HEARTBEAT);
  }

  // 定时清理过期房间（>1小时无活动）
  startCleanupLoop() {
    setInterval(() => {
      const now = Date.now();
      for (const [code, room] of Object.entries(this.rooms)) {
        if (now - room.createdAt > 3600000 && room.players.every((p) => !p.connected)) {
          this.destroyRoom(code);
        }
      }
    }, 60000);
  }
}

const roomManager = new RoomManager();

module.exports = { Room, RoomManager, roomManager, TIMEOUTS };
