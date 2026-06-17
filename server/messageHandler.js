/**
 * MessageHandler - WebSocket 消息分发处理
 *
 * 上行消息 (client → server):
 *   CREATE_ROOM, JOIN_ROOM, ROLL_DICE, PICK_CHARACTER,
 *   PLAY_CARD, CHAIN_CONTINUE, PICK_GIFT_CARD, END_TURN, PING
 *
 * 下行消息 (server → client):
 *   ROOM_CREATED, JOINED, STATE_SYNC, YOUR_HAND,
 *   REQUEST_TARGET, GAME_LOG, ERROR, PONG
 */

const { roomManager, TIMEOUTS } = require("./roomManager");
const { makeError } = require("./util");

/**
 * 发送消息给单个客户端
 */
function send(ws, type, payload = {}) {
  if (ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(
    JSON.stringify({
      type,
      timestamp: Date.now(),
      payload,
    })
  );
}

/**
 * 广播消息给房间内所有已连接客户端
 */
function broadcast(room, type, payload = {}) {
  for (const player of room.players) {
    if (player.ws && player.connected) {
      send(player.ws, type, payload);
    }
  }
}

/**
 * 发送错误消息
 */
function sendError(ws, errKey, extraMsg = "") {
  send(ws, "ERROR", makeError(errKey, extraMsg));
}

/**
 * 同步公共游戏状态给房间所有人
 */
function syncState(room) {
  const publicState = room.getPublicState();
  for (const player of room.players) {
    if (player.ws && player.connected) {
      send(player.ws, "STATE_SYNC", publicState);
      // 同时发送该玩家的私有手牌
      const privateState = room.getPrivateState(player.id);
      if (privateState) {
        send(player.ws, "YOUR_HAND", privateState);
      }
    }
  }
}

/**
 * 处理客户端上行消息
 */
function handleMessage(ws, rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch {
    return sendError(ws, "INVALID_REQUEST");
  }

  const { type, payload = {} } = msg;

  switch (type) {
    // ===== 房间操作 =====
    case "CREATE_ROOM": {
      const room = roomManager.createRoom();
      const result = room.addPlayer(ws, payload.nickname || "Player");
      if (result.error) return sendError(ws, result.error);
      roomManager.mapPlayerToRoom(result.player.id, room.code);
      send(ws, "ROOM_CREATED", {
        roomCode: room.code,
        playerId: result.player.id,
        seatIndex: result.player.seatIndex,
      });
      syncState(room);
      break;
    }

    case "JOIN_ROOM": {
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");
      const result = room.addPlayer(ws, payload.nickname || "Player");
      if (result.error) return sendError(ws, result.error);
      roomManager.mapPlayerToRoom(result.player.id, room.code);
      send(ws, "JOINED", {
        roomCode: room.code,
        playerId: result.player.id,
        seatIndex: result.player.seatIndex,
      });
      syncState(room);
      break;
    }

    // ===== 选角阶段 =====
    case "ROLL_DICE": {
      const room = roomManager.getRoomByPlayer(payload.playerId);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");

      const player = room.getPlayer(payload.playerId);
      if (!player || player.seatIndex !== room.hostSeatIndex) {
        return sendError(ws, "INVALID_REQUEST", "仅房主可以掷骰");
      }

      const result = room.rollDice();
      if (result.error) return sendError(ws, result.error);

      // 广播掷骰结果
      broadcast(room, "DICE_ROLLED", {
        rolls: result.rolls,
        pickOrder: result.pickOrder,
      });
      syncState(room);

      // 设置选角超时
      room.timers["pickTimeout"] = setTimeout(() => {
        room.handleTimeout("PICK_CHARACTER");
        broadcast(room, "GAME_STARTED", {});
        syncState(room);
      }, TIMEOUTS.PICK_CHARACTER);
      break;
    }

    case "PICK_CHARACTER": {
      const room = roomManager.getRoomByPlayer(payload.playerId);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");

      const result = room.pickCharacter(payload.playerId, payload.characterId);
      if (result.error) return sendError(ws, result.error);

      broadcast(room, "CHARACTER_PICKED", {
        playerId: payload.playerId,
        characterId: payload.characterId,
      });
      syncState(room);

      // 如果进入发牌/游戏阶段，通知所有人
      if (result.phase === "PLAYING") {
        broadcast(room, "GAME_STARTED", {});
        syncState(room);
        // 清除选角超时
        if (room.timers["pickTimeout"]) {
          clearTimeout(room.timers["pickTimeout"]);
          delete room.timers["pickTimeout"];
        }
        // 设置出牌超时
        startPlayTimeout(room);
      }
      break;
    }

    // ===== 游戏阶段 =====
    case "PLAY_CARD": {
      const room = roomManager.getRoomByPlayer(payload.playerId);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");

      const result = room.playCard(
        payload.playerId,
        payload.cardId,
        payload.targets || []
      );
      if (result.error) return sendError(ws, result.error);

      if (result.gameOver) {
        broadcast(room, "GAME_OVER", {
          winner: result.winner
            ? {
                id: result.winner.id,
                character: result.winner.character,
              }
            : null,
        });
      }

      syncState(room);

      if (result.awaitingChain) {
        // 设置连锁超时
        if (room.timers["chainTimeout"]) clearTimeout(room.timers["chainTimeout"]);
        room.timers["chainTimeout"] = setTimeout(() => {
          room.handleTimeout("CHAIN");
          syncState(room);
        }, TIMEOUTS.CHAIN);
      } else {
        // 重置出牌超时
        resetPlayTimeout(room);
      }
      break;
    }

    case "CHAIN_CONTINUE": {
      const room = roomManager.getRoomByPlayer(payload.playerId);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");

      const result = room.chainContinue(
        payload.playerId,
        !!payload.continue,
        payload.cardId,
        payload.targets || []
      );
      if (result.error) return sendError(ws, result.error);

      if (result.gameOver) {
        broadcast(room, "GAME_OVER", {
          winner: result.winner
            ? { id: result.winner.id, character: result.winner.character }
            : null,
        });
      }

      if (room.timers["chainTimeout"]) {
        clearTimeout(room.timers["chainTimeout"]);
        delete room.timers["chainTimeout"];
      }
      syncState(room);
      resetPlayTimeout(room);
      break;
    }

    case "PICK_STEAL_CARD": {
      const room = roomManager.getRoomByPlayer(payload.playerId);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");

      const result = room.pickStealCard(payload.playerId, payload.cardId);
      if (result.error) return sendError(ws, result.error);

      syncState(room);
      resetPlayTimeout(room);
      break;
    }

    case "PICK_GIFT_CARD": {
      const room = roomManager.getRoomByPlayer(payload.playerId);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");

      const result = room.pickGiftCard(payload.playerId, payload.cardId);
      if (result.error) return sendError(ws, result.error);

      syncState(room);
      resetPlayTimeout(room);
      break;
    }

    case "END_TURN": {
      const room = roomManager.getRoomByPlayer(payload.playerId);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");

      const result = room.endTurn(payload.playerId);
      if (result.error) return sendError(ws, result.error);

      if (result.gameOver) {
        broadcast(room, "GAME_OVER", {
          winner: result.winner
            ? { id: result.winner.id, character: result.winner.character }
            : null,
        });
      }

      resetPlayTimeout(room);
      syncState(room);
      break;
    }

    // ===== 断线重连 =====
    case "RECONNECT": {
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return sendError(ws, "ROOM_NOT_FOUND");

      const result = room.handleReconnect(ws, payload.playerId);
      if (result.error) return sendError(ws, result.error);

      send(ws, "RECONNECTED", {
        roomCode: room.code,
        playerId: result.player.id,
      });
      syncState(room);
      break;
    }

    // ===== 心跳 =====
    case "PING": {
      send(ws, "PONG", {});
      if (payload.playerId) {
        const room = roomManager.getRoomByPlayer(payload.playerId);
        if (room) room.handlePing(payload.playerId);
      }
      break;
    }

    default:
      sendError(ws, "INVALID_REQUEST", `未知消息类型: ${type}`);
  }
}

// ===== 超时定时器辅助 =====

function startPlayTimeout(room) {
  resetPlayTimeout(room);
}

function resetPlayTimeout(room) {
  if (room.timers["playTimeout"]) {
    clearTimeout(room.timers["playTimeout"]);
  }
  room.timers["playTimeout"] = setTimeout(() => {
    if (room.phase === "PLAYING") {
      room.handleTimeout("PLAY_CARD");
      // 广播超时自动结束回合
      broadcast(room, "TIMEOUT", { action: "PLAY_CARD" });
      syncState(room);
      resetPlayTimeout(room);
    }
  }, TIMEOUTS.PLAY_CARD);
}

module.exports = { handleMessage, send, broadcast, syncState };
