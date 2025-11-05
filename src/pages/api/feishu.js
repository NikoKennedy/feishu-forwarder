// src/pages/api/feishu.js
export default async function handler(req, res) {
  // 可选：校验 Verification Token（你在 Vercel 的 FEISHU_VERIFICATION_TOKEN）
  const VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN || "";
  const APP_ID = process.env.FEISHU_APP_ID;
  const APP_SECRET = process.env.FEISHU_APP_SECRET;
  const SOURCE_CHAT_ID = process.env.SOURCE_CHAT_ID || "";
  const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
  const KEYWORDS = process.env.KEYWORDS || "";

  if (!APP_ID || !APP_SECRET || !TARGET_CHAT_ID) {
    return res.status(500).json({ code: 1, msg: "Missing env: FEISHU_APP_ID / FEISHU_APP_SECRET / TARGET_CHAT_ID" });
  }

  // 1) 处理 URL 验证（飞书事件订阅）
  if (req.body && req.body.type === "url_verification") {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  // 2)（可选）校验 Verification Token
  const tokenInBody = (req.body && (req.body.token || (req.body.header && req.body.header.token))) || "";
  if (VERIFICATION_TOKEN && tokenInBody && tokenInBody !== VERIFICATION_TOKEN) {
    return res.status(403).json({ code: 1, msg: "invalid verification token" });
  }

  // 3) 只处理消息事件
  const header = (req.body && req.body.header) || {};
  const eventType = header.event_type || (req.body && req.body.event && req.body.event.type);
  const event = (req.body && req.body.event) || {};

  if (eventType !== "im.message.receive_v1") {
    return res.status(200).json({ code: 0, msg: "ignored" });
  }

  const parsed = parseMessage(event);
  const { msgType, chatId, senderType, content } = parsed;

  // 避免机器人自己触发循环
  if (senderType && senderType !== "user") {
    return res.status(200).json({ code: 0, msg: "ignore non-user sender" });
  }

  // 只监听特定源群（如果设置了）
  if (SOURCE_CHAT_ID && chatId !== SOURCE_CHAT_ID) {
    return res.status(200).json({ code: 0, msg: "ignore other chats" });
  }

  try {
    if (msgType === "text") {
      const text = (content && content.text) || "";
      if (matchKeywords(text, KEYWORDS)) {
        await sendToTarget("text", { text }, APP_ID, APP_SECRET, TARGET_CHAT_ID);
      }
    } else if (msgType === "image") {
      const imageKey = (content && (content.image_key || (content.image_keys && content.image_keys[0]))) || "";
      if (imageKey) {
        await sendToTarget("image", { image_key: imageKey }, APP_ID, APP_SECRET, TARGET_CHAT_ID);
      }
    }
    return res.status(200).json({ code: 0 });
  } catch (e) {
    console.error("forward error:", e && e.message ? e.message : e);
    return res.status(500).json({ code: 1, msg: (e && e.message) || "error" });
  }
}

function parseMessage(event) {
  const msgType = (event && event.message && (event.message.message_type || event.message.msg_type)) || "";
  const chatId = (event && event.message && event.message.chat_id) || "";
  const senderType = (event && event.sender && event.sender.sender_type) || "";
  const contentRaw = (event && event.message && event.message.content) || "";
  let content = {};
  try { content = JSON.parse(contentRaw); } catch (_) {}
  return { msgType, chatId, senderType, content, contentRaw };
}

function matchKeywords(text, KEYWORDS) {
  if (!KEYWORDS || !KEYWORDS.trim()) return true; // 不设关键词 = 全转发
  const list = KEYWORDS.split(",").map(s => s.trim()).filter(Boolean);
  for (const raw of list) {
    if (raw.startsWith("/") && raw.endsWith("/")) {
      // 支持 /pattern/flags
      const body = raw.slice(1, -1);
      const m = body.match(/^(.*)\/([gimsuy]*)$/);
      let re;
      if (m) re = new RegExp(m[1], m[2]);
      else re = new RegExp(body);
      if (re.test(text)) return true;
    } else {
      // 简单包含，支持 * 通配
      const pattern = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
      const re2 = new RegExp(pattern, "i");
      if (re2.test(text)) return true;
    }
  }
  return false;
}

let cachedToken = null;
async function getTenantAccessToken(APP_ID, APP_SECRET) {
  const now = Date.now();
  if (cachedToken && cachedToken.expireAt > now + 60 * 1000) {
    return cachedToken.token;
  }
  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await resp.json();
  if (!data || data.code !== 0) {
    throw new Error(`get tenant_access_token failed: ${JSON.stringify(data)}`);
  }
  cachedToken = {
    token: data.tenant_access_token,
    expireAt: now + (data.expire || 0) * 1000 - 10 * 1000,
  };
  return cachedToken.token;
}

async function sendToTarget(msg_type, contentObj, APP_ID, APP_SECRET, TARGET_CHAT_ID) {
  const token = await getTenantAccessToken(APP_ID, APP_SECRET);
  const url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";
  const payload = {
    receive_id: TARGET_CHAT_ID,
    msg_type,
    content: JSON.stringify(contentObj),
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!data || data.code !== 0) {
    console.error("sendToTarget failed:", data);
    throw new Error("sendToTarget failed");
  }
}

// 允许较大的 JSON 体
export const config = {
  api: { bodyParser: { sizeLimit: "2mb" } }
};
