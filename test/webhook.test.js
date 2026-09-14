const test = require("node:test");
const assert = require("node:assert/strict");
const { Webhook } = require("svix");
const { processResendWebhook } = require("../index");

function fakePool({ duplicate = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO email_events")) return { rowCount: duplicate ? 0 : 1, rows: duplicate ? [] : [{ id: 1 }] };
      if (sql.includes("SELECT id,contact_id")) return { rowCount: 1, rows: [{ id: 7, contact_id: 9, campaign_id: 3, email: "user@example.com" }] };
      return { rowCount: 1, rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); }
  };
  return { calls, async connect() { return client; } };
}

test("webhook processing updates delivery and is transactional", async () => {
  const pool = fakePool();
  const result = await processResendWebhook(pool, {
    type: "email.delivered", created_at: "2026-09-14T20:00:00.000Z",
    data: { email_id: "resend-123" }
  }, "msg-1");
  assert.equal(result.processed, true);
  assert.ok(pool.calls.some(call => call.sql.includes("delivered_at")));
  assert.ok(pool.calls.some(call => call.sql === "COMMIT"));
});

test("duplicate svix-id is acknowledged without reprocessing", async () => {
  const pool = fakePool({ duplicate: true });
  const result = await processResendWebhook(pool, { type: "email.opened", data: { email_id: "x" } }, "same-id");
  assert.equal(result.duplicate, true);
  assert.equal(pool.calls.filter(call => call.sql.includes("open_count")).length, 0);
});

test("bounce creates suppression history", async () => {
  const pool = fakePool();
  await processResendWebhook(pool, { type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "x" } }, "bounce-1");
  assert.ok(pool.calls.some(call => call.sql.includes("UPDATE contacts SET status='suppressed'")));
  assert.ok(pool.calls.some(call => call.sql.includes("INSERT INTO suppression_history")));
});

test("Svix rejects an invalid signature", () => {
  const secret = `whsec_${Buffer.from("01234567890123456789012345678901").toString("base64")}`;
  assert.throws(() => new Webhook(secret).verify("{}", {
    "svix-id": "msg_test", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,invalid"
  }));
});
