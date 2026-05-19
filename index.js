const express = require("express");
const { Resend } = require("resend");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(express.json({ limit: "25mb" }));

const resend = new Resend(process.env.RESEND_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const FROM_EMAIL = "App Clarity Support <suporte@claritynotify.online>";
const REPLY_TO_EMAIL = "suporte@claritynotify.online";
const APP_URL = "https://perfect-reflection-production.up.railway.app";

const ALLOWED_LINKS = [
  "https://smsgrab.lovable.app",
  "https://teleggrab.lovable.app",
  "https://whatsgrab.lovable.app",
  "https://snap-radar-pro.lovable.app",
  "https://apptinder.lovable.app",
  "https://galeria.fabricadeaplicativos.com.br/securespy"
];

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isAllowedLink(url) {
  return ALLOWED_LINKS.some(link => url.startsWith(link));
}

function addTrackingToHtml(html, logId) {
  let trackedHtml = String(html || "");

  trackedHtml = trackedHtml.replace(/href=["']([^"']+)["']/gi, (match, url) => {
    if (!isAllowedLink(url)) {
      return match;
    }

    const trackedUrl = `${APP_URL}/click/${logId}?url=${encodeURIComponent(url)}`;

    return `href="${trackedUrl}"`;
  });

  const openPixel = `
    <img 
      src="${APP_URL}/open/${logId}.png" 
      width="1" 
      height="1" 
      style="display:none;opacity:0;width:1px;height:1px;" 
      alt=""
    />
  `;

  if (trackedHtml.includes("</body>")) {
    trackedHtml = trackedHtml.replace("</body>", `${openPixel}</body>`);
  } else {
    trackedHtml += openPixel;
  }

  return trackedHtml;
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      html TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      html TEXT NOT NULL,
      daily_limit INTEGER DEFAULT 30,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER,
      contact_id INTEGER,
      email TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      resend_id TEXT,
      error_message TEXT,
      sent_at TIMESTAMP,
      delivered_at TIMESTAMP,
      opened_at TIMESTAMP,
      clicked_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_limit INTEGER DEFAULT 30;`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';`);
  await pool.query(`ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS contact_id INTEGER;`);
  await pool.query(`ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMP;`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS email_logs_campaign_email_unique
    ON email_logs (campaign_id, email);
  `);

  console.log("Database ready");
}

app.get("/", async (req, res) => {
  const contactsTotal = await pool.query(`SELECT COUNT(*) FROM contacts`);
  const campaignsTotal = await pool.query(`SELECT COUNT(*) FROM campaigns`);
  const pendingTotal = await pool.query(`SELECT COUNT(*) FROM email_logs WHERE status = 'pending'`);

  const sentToday = await pool.query(`
    SELECT COUNT(*) FROM email_logs
    WHERE status = 'sent'
    AND DATE(sent_at) = CURRENT_DATE
  `);

  const sentTotal = await pool.query(`SELECT COUNT(*) FROM email_logs WHERE status = 'sent'`);
  const errorsTotal = await pool.query(`SELECT COUNT(*) FROM email_logs WHERE status
