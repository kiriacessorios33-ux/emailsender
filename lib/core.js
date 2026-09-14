const crypto = require("crypto");

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(email));
}

function parseEmailInput(input) {
  const tokens = String(input || "")
    .split(/[\r\n,;]+/)
    .map(cleanEmail)
    .filter(Boolean);
  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicates = 0;

  for (const token of tokens) {
    if (!isValidEmail(token)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(token)) {
      duplicates += 1;
      continue;
    }
    seen.add(token);
    valid.push(token);
  }

  return { total: tokens.length, valid, invalid, duplicates };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/h[1-6]>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function createUnsubscribeToken(email, campaignId, secret) {
  if (!secret) throw new Error("UNSUBSCRIBE_SECRET is required");
  const payload = Buffer.from(JSON.stringify({
    email: cleanEmail(email),
    campaignId: Number(campaignId)
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyUnsubscribeToken(token, secret) {
  if (!secret || !token || !String(token).includes(".")) return null;
  const [payload, signature] = String(token).split(".");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(signature || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isValidEmail(data.email) || !Number.isInteger(data.campaignId)) return null;
    return { email: cleanEmail(data.email), campaignId: data.campaignId };
  } catch {
    return null;
  }
}

function eventUpdate(eventType) {
  const updates = {
    "email.sent": { status: "sent", timestamp: "sent_at" },
    "email.delivered": { status: "delivered", timestamp: "delivered_at" },
    "email.opened": { status: "opened", timestamp: "opened_at", increment: "open_count" },
    "email.clicked": { status: "clicked", timestamp: "clicked_at", increment: "click_count" },
    "email.bounced": { status: "bounced", timestamp: "bounced_at", suppress: "hard_bounce" },
    "email.complained": { status: "complained", timestamp: "complained_at", suppress: "complaint" }
  };
  return updates[eventType] || null;
}

function appendUnsubscribe(html, text, url) {
  const safeUrl = escapeHtml(url);
  const footer = `<div style="margin-top:32px;padding-top:18px;border-top:1px solid #e5e7eb;color:#6b7280;font:12px Arial,sans-serif;text-align:center">Você recebeu este e-mail porque autorizou comunicações da Clarity Access. <a href="${safeUrl}" style="color:#6b7280;text-decoration:underline">Cancelar inscrição</a>.</div>`;
  const htmlWithFooter = /<\/body>/i.test(String(html || ""))
    ? String(html).replace(/<\/body>/i, `${footer}</body>`)
    : `${String(html || "")}${footer}`;
  const plain = String(text || htmlToText(html));
  return { html: htmlWithFooter, text: `${plain}\n\nCancelar inscrição: ${url}` };
}

module.exports = {
  appendUnsubscribe,
  cleanEmail,
  createUnsubscribeToken,
  escapeHtml,
  eventUpdate,
  htmlToText,
  isValidEmail,
  parseEmailInput,
  verifyUnsubscribeToken
};
