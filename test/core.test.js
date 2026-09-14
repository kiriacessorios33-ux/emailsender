const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendUnsubscribe,
  createUnsubscribeToken,
  eventUpdate,
  htmlToText,
  parseEmailInput,
  verifyUnsubscribeToken
} = require("../lib/core");

test("manual paste accepts lines, commas and semicolons and deduplicates", () => {
  const result = parseEmailInput("A@Example.com\nb@example.com; a@example.com,invalid");
  assert.equal(result.total, 4);
  assert.deepEqual(result.valid, ["a@example.com", "b@example.com"]);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.invalid, ["invalid"]);
});

test("empty and malformed input is not eligible", () => {
  const result = parseEmailInput(" ;\nno-at-sign; x@y");
  assert.equal(result.valid.length, 0);
  assert.equal(result.invalid.length, 2);
});

test("unsubscribe token is signed and detects tampering", () => {
  const token = createUnsubscribeToken("USER@example.com", 42, "test-secret");
  assert.deepEqual(verifyUnsubscribeToken(token, "test-secret"), { email: "user@example.com", campaignId: 42 });
  assert.equal(verifyUnsubscribeToken(`${token}x`, "test-secret"), null);
});

test("email includes HTML, text and visible unsubscribe", () => {
  const result = appendUnsubscribe("<html><body><h1>Olá</h1></body></html>", "", "https://mail.clarity-access.com/u/token");
  assert.match(result.html, /Cancelar inscrição/);
  assert.match(result.text, /Olá/);
  assert.match(result.text, /https:\/\/mail\.clarity-access\.com/);
});

test("HTML-to-text removes scripts and keeps readable content", () => {
  assert.equal(htmlToText("<h1>Título</h1><script>bad()</script><p>Texto</p>"), "Título\n Texto");
});

test("all requested Resend events have a processing plan", () => {
  for (const type of ["email.sent", "email.delivered", "email.opened", "email.clicked", "email.bounced", "email.complained"]) {
    assert.ok(eventUpdate(type), type);
  }
  assert.equal(eventUpdate("unknown"), null);
});
