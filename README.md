# 旧日圣契

回合制卡牌对战游戏 — 6 角色 × 120 张独立卡牌，权威服务器 CS 架构。

## 技术栈

- **服务端**：Node.js + 原生 WebSocket (ws)，纯内存存储
- **前端**：原生 HTML/CSS/JS，Canvas 粒子特效 + Web Audio 音效
- **部署**：Render Web Service（免费套餐）

## 快速开始

```bash
cd server
npm install
npm start
# 打开浏览器访问 http://localhost:3000
```

## 项目结构

```
server/
├── server.js          # 入口：HTTP + WebSocket 服务
├── gameEngine.js      # 核心结算引擎、伤害优先级、效果处理器
├── roomManager.js     # 房间状态机、超时/断线/托管
├── messageHandler.js  # WebSocket 消息路由分发
├── deckManager.js     # 牌库操作：抽牌/洗牌/弃牌
├── buffManager.js     # Buff 生命周期管理
├── cards.json         # 120 张卡牌全量数据
├── util.js            # 工具函数 + 错误码表
└── package.json

client/
├── index.html         # 完整 SPA 游戏界面（Emoji + Canvas 特效 + Web Audio 音效）
└── cards_data.js      # 卡牌前端映射表
```

## 6 角色

| 角色 | 主题色 | 特色 |
|------|--------|------|
| ⚔️ 战士 | 红色 | 血怒 Buff、高爆发 |
| ✨ 牧师 | 金色 | 治疗续航、血量交换 |
| 🧙 法师 | 蓝色 | 雷暴诅咒、祈祷抽牌 |
| 🛡️ 坦克 | 绿色 | 反伤绿盾、破盾 |
| 🐺 兽人 | 橙色 | 熊/狼/虎三形态变身 |
| 🗡️ 刺客 | 紫色 | 窥视换牌、隐身免伤 |

## 游戏规则

- 每人牌库 18-22 张，初始手牌 0 张
- 每回合抽 1 张，必须出 1 张牌
- 卡牌含 ⚡ 闪电可继续出牌
- 手牌归零自动补 2 张
- 伤害优先级：隐身免疫 → 真实伤害 → 绿盾反伤 → 普通护盾 → 扣血
