/**
 * RoomManager - 房间管理模块
 *
 * 房间状态机：
 *   WAITING → ROLLING → PICKING → DEALING → PLAYING → GAME_OVER
 *
 * 超时机制：
 *   选角 30s | 出牌 60s | 闪电连锁 15s | 断线托管 90s
 *
 * 依赖方向（无循环）：
 *   roomManager → gameEngine / deckManager / buffManager / util
 *   messageHandler → roomManager
 *   Room 通过构造函数注入 destroyFn / sendFn，不 require 自身或 messageHandler
 */

const {
  generateRoomCode, generatePlayerId, deepClone,
  shuffle, sendToPlayer,
} = require("./util");
const {
  CHARACTERS, createInitialGameState, resolve, resolveChain,
  skipChain, checkWinCondition, getNextAlivePlayer,
  resolveStealPick, resolveGiftPick,
} = require("./gameEngine");
const { drawCards } = require("./deckManager");
const { onTurnStart, onTurnEnd } = require("./buffManager");
const CARDS = require("./cards.json");

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

/** 生成战斗日志：卡牌名 + 图标 + 目标 */
function formatCardPlayLog(cardId, gameState, targets) {
  const card = CARDS[cardId];
  if (!card) return cardId;
  const counts = {};
  for (const e of (card.effects || [])) counts[e] = (counts[e] || 0) + 1;
  const order = ['🗡️','🛡️','❤️','🃏','⚡','🔰','💥','🩸','💕','♻️','⛈️','🙏','🐾','🐻','🐺','🐯','👀','🫥'];
  const iconStr = order.filter(o => counts[o]).map(o => counts[o] > 1 ? `${o}x${counts[o]}` : o).join(' ') || '';
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

// ========== Room 类 ==========

class Room {
  /**
/**
   * @param {string} code 房间码
   * @param {Function} destroyFn 销毁房间回调 (roomCode => void)
   * @param {Function} sendFn 发送消息回调 (ws, type, payload => void)
   * @param {Function} unmapFn 解除玩家映射回调 (playerId => void)
   */
  constructor(code, destroyFn, sendFn, unmapFn) {
    this.code = code;
    this._destroy = destroyFn;
    this._send = sendFn;
    this._unmap = unmapFn;
    this.phase = "WAITING";
    this.players = [];
    this.maxPlayers = 4;
    this.gameState = null;
    this.hostSeatIndex = 0;
    this.pickOrder = [];
    this.pickIndex = 0;
    this.timers = {};
    this.heartbeatMisses = {};
    this.createdAt = Date.now();
    this._lock = false;       // 操作互斥锁，防止信号干扰
  }

  // ===== 操作锁 =====
  _acquire() { if (this._lock) return false; this._lock = true; return true; }
  _release() { this._lock = false; }
  _guarded(fn) {
    if (!this._acquire()) return { error: "SERVER_BUSY", msg: "操作进行中，请稍后重试" };
    try { return fn(); } finally { this._release(); }
  }

  // ===== 玩家管理 =====

  addPlayer(ws, nickname) {
    if (this.players.length >= this.maxPlayers) return { error: "ROOM_FULL" };
    if (this.phase !== "WAITING") return { error: "ROOM_ALREADY_STARTED" };

    // 防止同一连接重复加入（幽灵玩家）
    const existing = this.players.find(p => p.ws === ws);
    if (existing) {
      existing.nickname = nickname || existing.nickname;
      return { success: true, player: existing, alreadyJoined: true };
    }

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
    const idx = this.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;
    this.players.splice(idx, 1);
    delete this.heartbeatMisses[playerId];
    this.players.forEach((p, i) => (p.seatIndex = i));
  }

  getPlayer(playerId) {
    return this.players.find(p => p.id === playerId);
  }

  getPlayerByWs(ws) {
    return this.players.find(p => p.ws === ws);
  }

  // ===== 断线/重连 =====

  handleDisconnect(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return;
    player.connected = false;

    // 房主在游戏开始前退出 → 房间自动解散
    if (player.seatIndex === this.hostSeatIndex &&
        (this.phase === "WAITING" || this.phase === "ROLLING" || this.phase === "PICKING")) {
      for (const p of this.players) {
        if (p.ws && p.connected && p.id !== playerId) {
          this._send(p.ws, "ROOM_DISMISSED", { msg: "房主已退出，房间解散" });
        }
      }
      this._destroy(this.code);
      return;
    }

    if (this.phase === "PLAYING" || this.phase === "PICKING") {
      this.timers["disconnect_" + playerId] = setTimeout(() => {
        this.handleAbandon(playerId);
      }, TIMEOUTS.DISCONNECT);
    } else {
      this._unmap && this._unmap(playerId);
      this.removePlayer(playerId);
      // 广播更新后的玩家列表
      this._broadcastState();
    }
  }

  // 广播当前状态给所有已连接玩家（用于断线/踢人等非游戏操作的同步）
  _broadcastState() {
    const pub = this.getPublicState();
    for (const p of this.players) {
      if (p.ws && p.connected) {
        this._send(p.ws, "STATE_SYNC", pub);
      }
    }
  }

  handleReconnect(ws, playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return { error: "PLAYER_NOT_FOUND" };
    player.ws = ws;
    player.connected = true;
    this.heartbeatMisses[playerId] = 0;
    const key = "disconnect_" + playerId;
    if (this.timers[key]) {
      clearTimeout(this.timers[key]);
      delete this.timers[key];
    }
    return { success: true, player };
  }

  handleAbandon(playerId) {
    // 超时弃权：标记死亡，若为当前回合则推进
    if (this.gameState) {
      const gsPlayer = this.gameState.players.find(p => p.id === playerId);
      if (gsPlayer) {
        gsPlayer.isAlive = false;
        gsPlayer.connected = false;
      }
      // 如果弃权者是当前回合人，自动推进回合
      const turnOrder = this.gameState.turnOrder;
      const curIdx = this.gameState.currentPlayerIndex;
      if (turnOrder && turnOrder[curIdx] === playerId) {
        this.gameState.gameLogs.push("⏰ " + (gsPlayer ? (gsPlayer.nickname || gsPlayer.character) : playerId) + " 断线弃权");
        this.gameState.awaitingChain = false;
        this.gameState.chainPlayerId = "";
        this.gameState._pendingStealPick = false;
        this.gameState._pendingGiftPick = false;
        if (!this.gameState._hasPlayed) {
          this.gameState._hasPlayed = true;
        }
        const endResult = this.endTurn(playerId);
        if (endResult && endResult.success) return;
      }
    }
    const player = this.getPlayer(playerId);
    if (player) player.connected = false;

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
    for (const player of this.players) {
      player.diceRoll = Math.floor(Math.random() * 6) + 1;
    }

    this.pickOrder = [...this.players]
      .sort((a, b) => b.diceRoll - a.diceRoll || a.seatIndex - b.seatIndex)
      .map(p => p.id);
    this.pickIndex = 0;
    this.phase = "PICKING";

    return {
      success: true,
      rolls: this.players.map(p => ({
        playerId: p.id, nickname: p.nickname,
        seatIndex: p.seatIndex, diceRoll: p.diceRoll,
      })),
      pickOrder: [...this.pickOrder],
    };
  }

  pickCharacter(playerId, characterId) {
    if (this.phase !== "PICKING") return { error: "NOT_PICKING_PHASE" };
    if (this.pickOrder[this.pickIndex] !== playerId) return { error: "NOT_YOUR_PICK_TURN" };
    if (!CHARACTERS[characterId]) return { error: "INVALID_CHARACTER" };

    const alreadyPicked = this.players.find(
      p => p.character === characterId && p.id !== playerId
    );
    if (alreadyPicked) return { error: "CHARACTER_ALREADY_PICKED" };

    const player = this.getPlayer(playerId);
    if (!player) return { error: "PLAYER_NOT_FOUND" };
    player.character = characterId;
    this.pickIndex++;

    if (this.pickIndex >= this.players.length) {
      return this.startDealing();
    }
    return { success: true, nextPicker: this.pickOrder[this.pickIndex] };
  }

  autoPickRemaining() {
    const availableChars = Object.keys(CHARACTERS).filter(
      c => !this.players.some(p => p.character === c)
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

    for (let i = 0; i < 3; i++) {
      for (const player of this.players) {
        this.gameState = drawCards(this.gameState, player.id, 1);
      }
    }

    const alivePlayers = this.gameState.players
      .filter(p => p.isAlive)
      .sort((a, b) => a.seatIndex - b.seatIndex);
    this.gameState.turnOrder = alivePlayers.map(p => p.id);
    this.gameState.currentPlayerIndex = 0;

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
    return this._guarded(() => this._playCardDirect(playerId, cardId, targets));
  }
  // 无锁版本，内部调用（如 _doForcePlayThenEndTurn）用
  _playCardDirect(playerId, cardId, targets) {
    if (this.phase !== "PLAYING") return { error: "ROOM_ALREADY_STARTED" };
    const gs = this.gameState;
    if (!gs) return { error: "SERVER_ERROR" };

    if (gs._pendingStealPick || gs._pendingGiftPick) {
      return { error: "INVALID_REQUEST", msg: "请先完成换牌选择" };
    }

    const currentPlayerId = gs.turnOrder[gs.currentPlayerIndex];
    if (currentPlayerId !== playerId) return { error: "NOT_YOUR_TURN" };
    if (gs.awaitingChain && gs.chainPlayerId !== playerId) {
      return { error: "NOT_YOUR_TURN", msg: "等待其他玩家连锁" };
    }
    if ((gs._playsRemaining || 0) <= 0 && !gs._pendingStealPick && !gs._pendingGiftPick) {
      return { error: "INVALID_REQUEST", msg: "本回合出牌次数已用完" };
    }

    const player = gs.players.find(p => p.id === playerId);
    if (!player || !player.isAlive) return { error: "PLAYER_NOT_ALIVE" };
    if (!player.hand.includes(cardId)) return { error: "INVALID_CARD" };

    const resolvedTargets = [];
    if (targets && targets.length > 0) {
      for (const t of targets) {
        const tp = gs.players.find(p => p.seatIndex === t && p.isAlive);
        if (!tp) return { error: "TARGET_NOT_ALIVE" };
        resolvedTargets.push(tp.id);
      }
    }

    if (gs.awaitingChain) {
      this.gameState = resolveChain(gs, playerId, cardId, resolvedTargets);
      this.gameState.gameLogs.push(
        "⚡ " + player.character + " " + formatCardPlayLog(cardId, this.gameState, resolvedTargets)
      );
    } else {
      this.gameState = resolve(gs, playerId, cardId, resolvedTargets);
      this.gameState.gameLogs.push(
        "🎴 " + player.character + " " + formatCardPlayLog(cardId, this.gameState, resolvedTargets)
      );
    }

    const result = checkWinCondition(this.gameState);
    if (result.gameOver) {
      this.endGame(result.winner);
      return { success: true, gameOver: true, winner: result.winner };
    }
    return { success: true, awaitingChain: this.gameState.awaitingChain };
  }

  // ===== 连锁继续/停止 =====

  chainContinue(playerId, wantContinue, cardId, targets) {
    return this._guarded(() => {
      if (!this.gameState || !this.gameState.awaitingChain) {
        return { error: "INVALID_REQUEST", msg: "不在连锁状态" };
      }
      if (this.gameState.chainPlayerId !== playerId) {
        return { error: "NOT_YOUR_TURN" };
      }
      if (wantContinue && cardId) {
        return this._playCardDirect(playerId, cardId, targets);
      }
      // 放弃连锁
      this.gameState = skipChain(this.gameState);
      this.gameState.gameLogs.push("⏭️ 放弃连锁");
      const result = checkWinCondition(this.gameState);
      if (result.gameOver) {
        this.endGame(result.winner);
        return { success: true, gameOver: true, winner: result.winner };
      }
      return { success: true };
    }); }

  // ===== 刺客换牌 =====

  pickStealCard(playerId, cardId) {
    return this._guarded(() => {
      if (!this.gameState) return { error: "SERVER_ERROR" };
      const gs = this.gameState;
    if (!gs._pendingStealPick) return { error: "INVALID_REQUEST", msg: "不在偷牌阶段" };
    if (gs._giftSourceId !== playerId) return { error: "NOT_YOUR_TURN" };

    const tgt = gs.players.find(p => p.id === gs._giftTargetId);
    if (!tgt || !tgt.hand.includes(cardId)) return { error: "INVALID_CARD" };

    this.gameState = resolveStealPick(gs, cardId);
    this.gameState.gameLogs.push("👀 窥视：偷取 1 张牌，等待选牌归还");
    return { success: true, phase: "gift" };
    }); } // close _guarded / pickStealCard

  pickGiftCard(playerId, cardId) {
    return this._guarded(() => {
      if (!this.gameState) return { error: "SERVER_ERROR" };
      const gs = this.gameState;
      if (!gs._pendingGiftPick) return { error: "INVALID_REQUEST", msg: "不在还牌阶段" };
      if (gs._giftSourceId !== playerId) return { error: "NOT_YOUR_TURN" };
      const player = gs.players.find(p => p.id === playerId);
      if (!player || !player.hand.includes(cardId)) return { error: "INVALID_CARD" };
      this.gameState = resolveGiftPick(gs, cardId);
      this.gameState.gameLogs.push("👀 窥视完成：交还 1 张牌");
      const result = checkWinCondition(this.gameState);
      if (result.gameOver) {
        this.endGame(result.winner);
        return { success: true, gameOver: true, winner: result.winner };
      }
      return { success: true };
    }); }

  // ===== 结束回合 =====

  endTurn(playerId) {
    return this._guarded(() => {
      if (this.phase !== "PLAYING") return { error: "ROOM_ALREADY_STARTED" };
    const gs = this.gameState;
    if (!gs) return { error: "SERVER_ERROR" };

    const currentPlayerId = gs.turnOrder[gs.currentPlayerIndex];
    // 回合已推进（如服务端超时自动过牌）→ 幂等返回成功
    if (currentPlayerId !== playerId) {
      const playerInTurn = gs.turnOrder.includes(playerId);
      if (playerInTurn) return { success: true, alreadyEnded: true };
      return { error: "NOT_YOUR_TURN" };
    }
    if (gs.awaitingChain) return { error: "INVALID_REQUEST", msg: "请先处理连锁" };
    if (gs._pendingStealPick || gs._pendingGiftPick) return { error: "INVALID_REQUEST", msg: "请先完成换牌选择" };

    if (!gs._hasPlayed) {
      return this._doForcePlayThenEndTurn(playerId);
    }

    return this._advanceTurn(playerId);
    }); }

  // 强制出牌然后推进回合（不递归，避免状态污染）
  _doForcePlayThenEndTurn(playerId) {
    const player = this.gameState.players.find(p => p.id === playerId);
    if (!player || !player.isAlive || player.hand.length === 0) {
      this.gameState._hasPlayed = true;
    } else {
      let cardId = player.hand.find(cid => {
        const c = CARDS[cid];
        return c && !(c.effects || []).some(e => ['🗡️','♻️','⛈️','👀','⚖️'].includes(e));
      });
      if (!cardId) cardId = player.hand[0];
      const enemies = this.gameState.players.filter(p => p.id !== playerId && p.isAlive);
      const target = enemies.length > 0 ? [enemies[0].seatIndex] : [];
      const autoTargets = enemies.length > 0 ? [enemies[0].id] : [];
      this.gameState.gameLogs.push("⏩ 自动 " + formatCardPlayLog(cardId, this.gameState, autoTargets));
      const playRes = this._playCardDirect(playerId, cardId, target);
      if (!playRes.success) return playRes;
      // 触发了连锁/换牌 → 不强行推进，等客户端操作
      if (this.gameState.awaitingChain || this.gameState._pendingStealPick || this.gameState._pendingGiftPick) {
        // 自动出牌触发连锁 → 设置连锁超时（15s后跳过链+推进回合）
        if (this.gameState.awaitingChain) {
          if (this.timers["chainTimeout"]) clearTimeout(this.timers["chainTimeout"]);
          this.timers["chainTimeout"] = setTimeout(() => {
            if (this.phase === "PLAYING" && this.gameState && this.gameState.awaitingChain) {
              this.gameState = skipChain(this.gameState);
              this.gameState.gameLogs.push("⏰ 连锁超时，自动终止");
              // 跳过链后立刻推进回合
              const curId = this.gameState.turnOrder[this.gameState.currentPlayerIndex];
              this._advanceTurn(curId);
              this._broadcastState();
            }
          }, TIMEOUTS.CHAIN);
        }
        return { success: true, awaitingChain: this.gameState.awaitingChain };
      }
    }
    return this._advanceTurn(playerId);
  }

  // 纯推进回合（不检查 _hasPlayed，不强制出牌）
  _advanceTurn(playerId) {
    const gs = this.gameState;
    const currentPlayerId = gs.turnOrder[gs.currentPlayerIndex];

    this.gameState = onTurnEnd(this.gameState, currentPlayerId);

    let result = checkWinCondition(this.gameState);
    if (result.gameOver) {
      this.endGame(result.winner);
      return { success: true, gameOver: true, winner: result.winner };
    }

    const currentPlayer = this.gameState.players.find(p => p.id === currentPlayerId);
    if (currentPlayer) {
      const nextPlayer = getNextAlivePlayer(this.gameState, currentPlayer.seatIndex);
      if (nextPlayer) {
        const nextIdx = this.gameState.turnOrder.indexOf(nextPlayer.id);
        this.gameState.currentPlayerIndex = nextIdx;
        this.gameState.turnCount++;
        this.gameState._playsRemaining = 1;
        this.gameState._hasPlayed = false;
        this.gameState = drawCards(this.gameState, nextPlayer.id, 1);
        this.gameState = onTurnStart(this.gameState, nextPlayer.id);
        this.gameState.gameLogs.push(
          "🔄 轮到 " + (nextPlayer.nickname || nextPlayer.character) +
          " (" + nextPlayer.character + " 座位" + nextPlayer.seatIndex + ")"
        );
      }
    }

    result = checkWinCondition(this.gameState);
    if (result.gameOver) {
      this.endGame(result.winner);
      return { success: true, gameOver: true, winner: result.winner };
    }
    return { success: true };
  }  // ===== 超时 =====

  handleTimeout(action) {
    if (action === "PLAY_CARD" || action === "END_TURN") {
      const gs = this.gameState;
      if (gs && gs.phase === "PLAYING") {
        const currentPlayerId = gs.turnOrder[gs.currentPlayerIndex];
        if (currentPlayerId && !gs.awaitingChain) {
          return this.endTurn(currentPlayerId);
        }
      }
    } else if (action === "CHAIN") {
      if (this.gameState && this.gameState.awaitingChain) {
        this.gameState = skipChain(this.gameState);
        this.gameState.gameLogs.push("⏰ 连锁超时，自动终止");
        const curId = this.gameState.turnOrder[this.gameState.currentPlayerIndex];
        this._advanceTurn(curId);
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
    this.timers["destroy"] = setTimeout(() => {
      this._destroy(this.code);
    }, TIMEOUTS.GAME_OVER);
  }

  // ===== 序列化 =====

  getPublicState() {
    if (!this.gameState) {
      return {
        roomCode: this.code,
        phase: this.phase,
        pickOrder: [...this.pickOrder],
        pickIndex: this.pickIndex,
        players: this.players.map(p => ({
          id: p.id, seatIndex: p.seatIndex, nickname: p.nickname,
          character: p.character, connected: p.connected, diceRoll: p.diceRoll,
        })),
      };
    }

    return {
      roomCode: this.code,
      phase: this.phase,
      players: this.gameState.players.map(p => ({
        id: p.id, seatIndex: p.seatIndex, nickname: p.nickname || "",
        character: p.character, hp: p.hp, maxHp: p.maxHp,
        shield: p.shield, greenShield: p.greenShield,
        handCount: p.hand.length, deckCount: p.deck.length,
        discardCount: p.discardPile.length, buffs: p.buffs,
        beastForm: p.beastForm, wolfBuff: p.wolfBuff || false,
        isAlive: p.isAlive, connected: p.connected,
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
    const player = this.gameState.players.find(p => p.id === playerId);
    if (!player) return null;
    const priv = {
      hand: player.hand,
      deckCount: player.deck.length,
      discardPile: [...player.discardPile],
    };
    if (this.gameState._pendingStealPick && this.gameState._giftSourceId === playerId) {
      priv.peekedHand = this.gameState._peekedHand || [];
      priv.peekTargetId = this.gameState._giftTargetId;
    }
    if (this.gameState._pendingGiftPick && this.gameState._giftSourceId === playerId) {
      priv.giftPickMode = true;
      priv.giftTargetId = this.gameState._giftTargetId;
    }
    return priv;
  }
}

// ========== 全局房间管理器 ==========

class RoomManager {
  constructor(sendFn) {
    this.rooms = {};
    this.playerRoomMap = {};
    this._send = sendFn || sendToPlayer;
  }

  createRoom() {
    const code = generateRoomCode();
    if (this.rooms[code]) return this.createRoom();
    const room = new Room(
      code,
      (c) => this.destroyRoom(c),
      this._send,
      (pid) => { delete this.playerRoomMap[pid]; }
    );
    this.rooms[code] = room;
    return room;
  }

  unmapPlayer(playerId) {
    delete this.playerRoomMap[playerId];
  }

  getRoom(code) {
    return this.rooms[code] || null;
  }

  destroyRoom(code) {
    const room = this.rooms[code];
    if (room) {
      for (const key of Object.keys(room.timers)) {
        clearTimeout(room.timers[key]);
      }
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

  startHeartbeatLoop() {
    setInterval(() => {
      for (const room of Object.values(this.rooms)) {
        room.checkHeartbeats();
      }
    }, TIMEOUTS.HEARTBEAT);
  }

  startCleanupLoop() {
    setInterval(() => {
      const now = Date.now();
      for (const [code, room] of Object.entries(this.rooms)) {
        if (now - room.createdAt > 3600000 && room.players.every(p => !p.connected)) {
          this.destroyRoom(code);
        }
      }
    }, 60000);
  }
}

const roomManager = new RoomManager();

module.exports = { Room, RoomManager, roomManager, TIMEOUTS };
