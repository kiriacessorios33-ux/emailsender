const test = require("node:test");
const assert = require("node:assert/strict");
const { Webhook } = require("svix");
const { createApp } = require("../index");

async function withServer(pool, run) {
  const oldUser = process.env.ADMIN_USERNAME;
  const oldPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = "tester";
  process.env.ADMIN_PASSWORD = "secret";
  const app = createApp({ pool, resend: { emails: { send: async () => { throw new Error("must not send"); } } } });
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (oldUser === undefined) delete process.env.ADMIN_USERNAME; else process.env.ADMIN_USERNAME = oldUser;
    if (oldPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = oldPassword;
  }
}

test("manual preview excludes suppressed and invalid contacts", async () => {
  const pool = {
    async query(sql) {
      assert.match(sql, /status IN \('suppressed','invalid'\)/);
      return { rowCount: 2, rows: [{ email: "blocked@example.com" }, { email: "bad@example.com" }] };
    }
  };
  await withServer(pool, async base => {
    const response = await fetch(`${base}/preview-recipients`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Basic ${Buffer.from("tester:secret").toString("base64")}` },
      body: JSON.stringify({ manualEmails: "ok@example.com;blocked@example.com;bad@example.com;ok@example.com;invalid" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { total: 5, duplicates: 1, invalid: 1, suppressed: 2, eligible: 1 });
  });
});

test("batch endpoint cannot send while safety gates are off", async () => {
  const beforeSend = process.env.SEND_ENABLED;
  const beforeVerified = process.env.SENDER_DOMAIN_VERIFIED;
  process.env.SEND_ENABLED = "false";
  process.env.SENDER_DOMAIN_VERIFIED = "false";
  try {
    await withServer({ async query() { throw new Error("database must not be touched"); } }, async base => {
      const response = await fetch(`${base}/send-batch/1`, { method: "POST", headers: { "authorization": `Basic ${Buffer.from("tester:secret").toString("base64")}` } });
      assert.equal(response.status, 423);
      assert.match(await response.text(), /Envio bloqueado/);
    });
  } finally {
    if (beforeSend === undefined) delete process.env.SEND_ENABLED; else process.env.SEND_ENABLED = beforeSend;
    if (beforeVerified === undefined) delete process.env.SENDER_DOMAIN_VERIFIED; else process.env.SENDER_DOMAIN_VERIFIED = beforeVerified;
  }
});

test("webhook endpoint rejects requests without configuration", async () => {
  const oldSecret = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  try {
    await withServer({ async query() { throw new Error("database must not be touched"); } }, async base => {
      const response = await fetch(`${base}/webhooks/resend`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}"
      });
      assert.equal(response.status, 503);
    });
  } finally {
    if (oldSecret !== undefined) process.env.RESEND_WEBHOOK_SECRET = oldSecret;
  }
});

test("webhook endpoint verifies a real Svix signature", async () => {
  const oldSecret = process.env.RESEND_WEBHOOK_SECRET;
  const secret = `whsec_${Buffer.from("01234567890123456789012345678901").toString("base64")}`;
  process.env.RESEND_WEBHOOK_SECRET = secret;
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("INSERT INTO email_events")) return { rowCount: 1, rows: [{ id: 1 }] };
      if (sql.includes("SELECT id,contact_id")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const payload = JSON.stringify({ type: "email.delivered", created_at: "2026-09-14T20:00:00.000Z", data: { email_id: "mail-1" } });
  const msgId = "msg_valid";
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(msgId, timestamp, payload);
  try {
    await withServer(pool, async base => {
      const response = await fetch(`${base}/webhooks/resend`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": msgId,
          "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
          "svix-signature": signature
        },
        body: payload
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).processed, true);
      assert.ok(queries.includes("COMMIT"));
    });
  } finally {
    if (oldSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET; else process.env.RESEND_WEBHOOK_SECRET = oldSecret;
  }
});
