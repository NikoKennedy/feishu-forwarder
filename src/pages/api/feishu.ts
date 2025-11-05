import type { NextApiRequest, NextApiResponse } from "next";

const APP_ID = process.env.FEISHU_APP_ID!;
const APP_SECRET = process.env.FEISHU_APP_SECRET!;
const VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN || "";
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || "";

const SOURCE_CHAT_ID = process.env.SOURCE_CHAT_ID || "";
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID!;

const KEYWORDS = process.env.KEYWORDS || "";

let cachedToken: { token: string; expireAt: number } | null = null;

async function getTenantAccessToken(): Promise<string> {
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
  if (data.code !== 0) {
    throw new Error(`get tenant_access_token failed: ${JSON.stringify(data)}`);
  }
  cachedToken = {
    token: data.tenant_access_token,
    expireAt: now + data.expire * 1000 - 10 * 1000,
  };
  return cachedToken.token;
}

function matchKeywords(text: string): boolean {
  if (!KEYWORDS.trim()) return true;
  for (const raw of KEYWORDS.split(",").map(s => s.trim()).filter(Boolean)) {
    if (raw.startsWith("/") && raw.endsWith("/")) {
      const body = raw.slice(1, -1);
      const m = body.match(/^(.*)\/([gimsuy]*)$/);
      let re: RegExp;
      if (m) re = new RegExp(m[1], m[2]);
      else re = new RegExp(body);
      if (re.test(text)) return true;
    } else {
      const pattern = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
      if (new RegExp(pattern, "i").test(text)) return true;
    }
  }
  return false;
}

async function sendToTarget(msg_type: "text" | "image", contentObj: any) {
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`;
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
  if (data.code !== 0) {
    console.error("sendToTarget failed:", data);
    throw new Error("sendToTarget failed");
  }
}

function parseMessage(event: any) {
  const msgType = event?.message?.message_type || event?.message?.msg_type;
  const chatId = event?.message?.chat_id;
  const senderType = event?.sender?.sender_type;
  const contentRaw = event?.message?.content || "";
  let content: any = {};
  try { content = JSON.parse(contentRaw); } catch { content = {}; }
  return { msgType, chatId, senderType, content, contentRaw };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.body?.type === "url_verification") {
    return res.status(200).json({ challenge: req.body?.challenge });
  }

  if (VERIFICATION_TOKEN) {
    const tokenInBody = req.body?.token || req.body?.header?.token;
    if (tokenInBody && tokenInBody !== VERIFICATION_TOKEN) {
      return res.status(403).json({ code: 1, msg: "invalid verification token" });
    }
  }

  const header = req.body?.header;
  const eventType = header?.event_type || req.body?.event?.type;
  const event = req.body?.event || {};

  if (eventType !== "im.message.receive_v1") {
    return res.status(200).json({ code: 0, msg: "ignored" });
  }

  const { msgType, chatId, senderType, content } = parseMessage(event);

  if (senderType && senderType !== "user") {
    return res.status(200).json({ code: 0, msg: "ignore non-user sender" });
  }

  if (SOURCE_CHAT_ID && chatId !== SOURCE_CHAT_ID) {
    return res.status(200).json({ code: 0, msg: "ignore other chats" });
  }

  try {
    if (msgType === "text") {
      const text = content?.text || "";
      if (matchKeywords(text)) {
        await sendToTarget("text", { text });
      }
    } else if (msgType === "image") {
      const imageKey = content?.image_key || (content?.image_keys?.[0]);
      if (imageKey) {
        await sendToTarget("image", { image_key: imageKey });
      }
    }
    return res.status(200).json({ code: 0 });
  } catch (e: any) {
    console.error("forward error:", e?.message || e);
    return res.status(500).json({ code: 1, msg: e?.message || "error" });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "2mb",
    },
  },
};
