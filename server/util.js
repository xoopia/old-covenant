/**
 * 工具函数 & 错误码表
 * 旧日圣契 - 附录B
 */

// ========== 错误码表 ==========
const ERROR_CODES = {
  // 通用
  UNKNOWN_ERROR:        { code: "E000", msg: "未知错误" },
  INVALID_REQUEST:      { code: "E001", msg: "无效请求" },

  // 房间相关 (E1xx)
  ROOM_NOT_FOUND:       { code: "E100", msg: "房间不存在" },
  ROOM_FULL:             { code: "E101", msg: "房间已满" },
  ROOM_ALREADY_STARTED:  { code: "E102", msg: "房间已开始对局" },
  ROOM_INVALID_CODE:     { code: "E103", msg: "房间码无效" },

  // 玩家相关 (E2xx)
  PLAYER_NOT_FOUND:      { code: "E200", msg: "玩家不存在" },
  PLAYER_ALREADY_IN_ROOM:{ code: "E201", msg: "玩家已在房间中" },
  PLAYER_NOT_READY:      { code: "E202", msg: "玩家未准备" },
  PLAYER_NOT_ALIVE:      { code: "E203", msg: "玩家已阵亡" },
  PLAYER_NOT_CONNECTED:  { code: "E204", msg: "玩家已断线" },

  // 游戏相关 (E3xx)
  NOT_YOUR_TURN:         { code: "E300", msg: "尚未轮到你的回合" },
  INVALID_CARD:          { code: "E301", msg: "该卡牌不在手牌中" },
  INVALID_TARGET:        { code: "E302", msg: "目标不合法" },
  TARGET_NOT_ALIVE:      { code: "E303", msg: "目标已阵亡" },
  TARGET_NOT_ADJACENT:   { code: "E304", msg: "目标不在攻击范围内" },
  DECK_EMPTY:            { code: "E305", msg: "牌库已空" },
  HAND_EMPTY:            { code: "E306", msg: "手牌为空" },
  ALREADY_PLAYED_THIS_TURN: { code: "E307", msg: "本回合已出过牌" },
  CHAIN_TIMEOUT:         { code: "E308", msg: "连锁超时，自动终止" },

  // 选角相关 (E4xx)
  NOT_PICKING_PHASE:     { code: "E400", msg: "当前不是选角阶段" },
  CHARACTER_ALREADY_PICKED: { code: "E401", msg: "该角色已被选择" },
  NOT_YOUR_PICK_TURN:    { code: "E402", msg: "尚未轮到你的选角顺序" },
  INVALID_CHARACTER:     { code: "E403", msg: "角色ID无效" },

  // 服务器相关 (E9xx)
  SERVER_ERROR:          { code: "E900", msg: "服务器内部错误" },
  SERVER_BUSY:           { code: "E901", msg: "服务器繁忙，请稍后重试" },
};

function makeError(errKey, extraMsg = "") {
  const e = ERROR_CODES[errKey] || ERROR_CODES.UNKNOWN_ERROR;
  return {
    error: true,
    code: e.code,
    msg: extraMsg ? `${e.msg}: ${extraMsg}` : e.msg,
  };
}

/**
 * 深拷贝工具 (不可变状态流)
 * Node 18+ 内置 structuredClone，这里做兼容封装
 */
function deepClone(obj) {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 生成4位房间码
 */
function generateRoomCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * 生成唯一玩家ID
 */
function generatePlayerId() {
  return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * 洗牌算法 (Fisher-Yates)
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  ERROR_CODES,
  makeError,
  deepClone,
  generateRoomCode,
  generatePlayerId,
  shuffle,
};
