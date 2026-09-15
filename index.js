const express = require("express");
const crypto = require("crypto");
const { Resend } = require("resend");
const multer = require("multer");
const { Pool } = require("pg");
const { Webhook } = require("svix");
const {
  appendUnsubscribe, cleanEmail, createUnsubscribeToken, escapeHtml,
  eventUpdate, htmlToText, isValidEmail, parseEmailInput, verifyUnsubscribeToken
} = require("./lib/core");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function createDependencies() {
  return {
    pool: new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "test" ? false : { rejectUnauthorized: false }
    }),
    // Staging must be able to boot with sending disabled and without a provider key.
    // The send route separately requires RESEND_API_KEY before any provider call.
    resend: process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
  };
}

async function initDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', base_type TEXT NOT NULL DEFAULT 'legacy',
      suppression_reason TEXT, suppressed_at TIMESTAMPTZ, unsubscribed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS templates (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL,
      html TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL,
      text_content TEXT, recipient_source TEXT NOT NULL DEFAULT 'legacy',
      daily_limit INTEGER DEFAULT 30, status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS email_logs (
      id SERIAL PRIMARY KEY, campaign_id INTEGER REFERENCES campaigns(id),
      contact_id INTEGER REFERENCES contacts(id), email TEXT NOT NULL,
      status TEXT DEFAULT 'pending', resend_id TEXT, error_message TEXT,
      sent_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, opened_at TIMESTAMPTZ,
      clicked_at TIMESTAMPTZ, bounced_at TIMESTAMPTZ, complained_at TIMESTAMPTZ,
      unsubscribed_at TIMESTAMPTZ, open_count INTEGER NOT NULL DEFAULT 0,
      click_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS email_events (
      id BIGSERIAL PRIMARY KEY, svix_id TEXT UNIQUE NOT NULL, event_type TEXT NOT NULL,
      resend_id TEXT, email_log_id INTEGER REFERENCES email_logs(id),
      event_created_at TIMESTAMPTZ, payload JSONB NOT NULL,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS suppression_history (
      id BIGSERIAL PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id), email TEXT NOT NULL,
      action TEXT NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL, campaign_id INTEGER,
      evidence JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  const migrations = [
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS base_type TEXT NOT NULL DEFAULT 'legacy'`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS suppression_reason TEXT`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS suppressed_at TIMESTAMPTZ`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ`,
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_limit INTEGER DEFAULT 30`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS text_content TEXT`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS recipient_source TEXT NOT NULL DEFAULT 'legacy'`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS contact_id INTEGER`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS complained_at TIMESTAMPTZ`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS open_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0`
  ];
  for (const migration of migrations) await pool.query(migration);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS email_logs_campaign_email_unique ON email_logs (campaign_id,email)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS email_logs_resend_id_unique ON email_logs (resend_id) WHERE resend_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS contacts_status_base_idx ON contacts (status,base_type)`);
  console.log("Database ready");
}

async function processResendWebhook(pool, event, svixId) {
  const update = eventUpdate(event.type);
  if (!update) return { ignored: true };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO email_events (svix_id,event_type,resend_id,event_created_at,payload)
       VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (svix_id) DO NOTHING RETURNING id`,
      [svixId, event.type, event.data && event.data.email_id, event.created_at, JSON.stringify(event)]
    );
    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      return { duplicate: true };
    }
    const logResult = await client.query(
      `SELECT id,contact_id,campaign_id,email FROM email_logs WHERE resend_id=$1 FOR UPDATE`,
      [event.data && event.data.email_id]
    );
    if (logResult.rowCount) {
      const log = logResult.rows[0];
      const at = event.created_at || new Date().toISOString();
      if (event.type === "email.sent") {
        await client.query(`UPDATE email_logs SET sent_at=COALESCE(sent_at,$1),status=CASE WHEN status IN ('pending','processing') THEN 'sent' ELSE status END WHERE id=$2`, [at, log.id]);
      } else if (event.type === "email.delivered") {
        await client.query(`UPDATE email_logs SET delivered_at=COALESCE(delivered_at,$1),status=CASE WHEN status NOT IN ('bounced','complained') THEN 'delivered' ELSE status END WHERE id=$2`, [at, log.id]);
      } else if (event.type === "email.opened") {
        await client.query(`UPDATE email_logs SET opened_at=COALESCE(opened_at,$1),open_count=open_count+1 WHERE id=$2`, [at, log.id]);
      } else if (event.type === "email.clicked") {
        await client.query(`UPDATE email_logs SET clicked_at=COALESCE(clicked_at,$1),click_count=click_count+1 WHERE id=$2`, [at, log.id]);
      } else {
        const bounce = event.type === "email.bounced";
        const reason = bounce ? "hard_bounce" : "complaint";
        const status = bounce ? "bounced" : "complained";
        const column = bounce ? "bounced_at" : "complained_at";
        await client.query(`UPDATE email_logs SET status=$1,${column}=COALESCE(${column},$2) WHERE id=$3`, [status, at, log.id]);
        await client.query(`UPDATE contacts SET status='suppressed',suppression_reason=$1,suppressed_at=COALESCE(suppressed_at,$2),updated_at=NOW() WHERE id=$3`, [reason, at, log.contact_id]);
        await client.query(`INSERT INTO suppression_history (contact_id,email,action,reason,source,campaign_id,evidence) VALUES ($1,$2,'suppress',$3,'resend_webhook',$4,$5::jsonb)`, [log.contact_id, log.email, reason, log.campaign_id, JSON.stringify({ svixId, resendId: event.data.email_id })]);
      }
      await client.query(`UPDATE email_events SET email_log_id=$1 WHERE svix_id=$2`, [log.id, svixId]);
    }
    await client.query("COMMIT");
    return { processed: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createApp({ pool, resend }) {
  const app = express();

  app.post("/webhooks/resend", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
    if (!process.env.RESEND_WEBHOOK_SECRET) return res.status(503).send("Webhook is not configured");
    const svixId = req.get("svix-id");
    let event;
    try {
      const rawPayload = req.body.toString("utf8");
      new Webhook(process.env.RESEND_WEBHOOK_SECRET).verify(rawPayload, {
        "svix-id": svixId,
        "svix-timestamp": req.get("svix-timestamp"),
        "svix-signature": req.get("svix-signature")
      });
      event = JSON.parse(rawPayload);
    } catch (error) {
      console.warn("Rejected Resend webhook signature", error.message);
      return res.status(400).send("Invalid webhook signature");
    }
    try {
      const result = await processResendWebhook(pool, event, svixId);
      return res.status(200).json({ received: true, ...result });
    } catch (error) {
      console.error("Webhook processing error", error);
      return res.status(500).send("Webhook processing failed");
    }
  });

  app.use(express.urlencoded({ extended: true, limit: "25mb" }));
  app.use(express.json({ limit: "25mb" }));

  // The unsubscribe and webhook surfaces are public; management screens are not.
  app.use((req, res, next) => {
    const isPublic = req.path === "/unsubscribe" || req.path === "/health" ||
      req.path.startsWith("/open/") || req.path.startsWith("/click/");
    if (isPublic) return next();
    const expectedUser = process.env.ADMIN_USERNAME;
    const expectedPassword = process.env.ADMIN_PASSWORD;
    if (!expectedUser || !expectedPassword) return res.status(503).send("Admin authentication is not configured");
    const [scheme, encoded] = String(req.get("authorization") || "").split(" ");
    if (scheme !== "Basic" || !encoded) {
      res.set("WWW-Authenticate", 'Basic realm="App Clarity"');
      return res.status(401).send("Authentication required");
    }
    let supplied = "";
    try { supplied = Buffer.from(encoded, "base64").toString("utf8"); } catch {}
    const separator = supplied.indexOf(":");
    const user = separator >= 0 ? supplied.slice(0, separator) : "";
    const password = separator >= 0 ? supplied.slice(separator + 1) : "";
    const digest = value => crypto.createHash("sha256").update(String(value)).digest();
    if (!crypto.timingSafeEqual(digest(user), digest(expectedUser)) || !crypto.timingSafeEqual(digest(password), digest(expectedPassword))) {
      res.set("WWW-Authenticate", 'Basic realm="App Clarity"');
      return res.status(401).send("Invalid credentials");
    }
    return next();
  });

  app.get("/", async (req, res) => {
    try {
      const [contactStats, metricStats, campaigns, templates, recentLogs, suppressions] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER (WHERE base_type='validated' AND status='active')::int validated,COUNT(*) FILTER (WHERE base_type='legacy' AND status='active')::int legacy,COUNT(*) FILTER (WHERE status='suppressed')::int suppressed,COUNT(*) FILTER (WHERE status='invalid')::int invalid FROM contacts`),
        pool.query(`SELECT COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int sent,COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int delivered,COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int unique_opens,COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int unique_clicks FROM email_logs`),
        pool.query(`SELECT c.*,COUNT(l.id)::int total_queue,COUNT(l.id) FILTER (WHERE l.status='pending')::int pending_count,COUNT(l.id) FILTER (WHERE l.sent_at IS NOT NULL)::int sent_count,COUNT(l.id) FILTER (WHERE l.delivered_at IS NOT NULL)::int delivered_count,COALESCE(SUM(l.open_count),0)::int open_count,COUNT(l.id) FILTER (WHERE l.opened_at IS NOT NULL)::int unique_open_count,COALESCE(SUM(l.click_count),0)::int click_count,COUNT(l.id) FILTER (WHERE l.clicked_at IS NOT NULL)::int unique_click_count,COUNT(l.id) FILTER (WHERE l.bounced_at IS NOT NULL)::int bounce_count,COUNT(l.id) FILTER (WHERE l.complained_at IS NOT NULL)::int complaint_count,COUNT(l.id) FILTER (WHERE l.unsubscribed_at IS NOT NULL)::int unsubscribe_count FROM campaigns c LEFT JOIN email_logs l ON l.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC LIMIT 30`),
        pool.query(`SELECT * FROM templates ORDER BY created_at DESC`),
        pool.query(`SELECT * FROM email_logs ORDER BY created_at DESC LIMIT 30`),
        pool.query(`SELECT email,suppression_reason,suppressed_at,unsubscribed_at FROM contacts WHERE status='suppressed' ORDER BY COALESCE(suppressed_at,unsubscribed_at,updated_at) DESC LIMIT 30`)
      ]);
      const cs = contactStats.rows[0];
      const ms = metricStats.rows[0];
      const templatesJson = JSON.stringify(templates.rows).replaceAll("<", "\\u003c");
      const sendReady = process.env.SEND_ENABLED === "true" && process.env.SENDER_DOMAIN_VERIFIED === "true";
      res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App Clarity</title><style>
      :root{--bg:#080b12;--panel:#111827;--panel2:#172033;--line:#263249;--text:#f8fafc;--muted:#94a3b8;--brand:#8b5cf6;--brand2:#6d28d9}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}.shell{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:100vh}.nav{position:sticky;top:0;height:100vh;padding:24px 16px;border-right:1px solid var(--line);background:#0c111d}.brand{font-size:21px;font-weight:800;margin:0 8px 24px;color:#c4b5fd}.nav a{display:block;padding:11px 12px;margin:5px 0;border-radius:9px;color:#cbd5e1;text-decoration:none;font-size:14px}.nav a:hover{background:var(--panel2);color:white}.main{padding:28px;max-width:1500px;width:100%}.header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:24px}h1{font-size:28px;margin:0 0 6px}h2{font-size:19px;margin:0 0 8px}.muted{color:var(--muted);font-size:13px}.notice{padding:10px 14px;border:1px solid ${sendReady ? "#065f46" : "#92400e"};background:${sendReady ? "#052e2b" : "#2b1b08"};border-radius:10px;font-size:13px}.stats{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:12px;margin-bottom:22px}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:18px;overflow:hidden}.stat strong{display:block;font-size:25px;margin-bottom:4px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}label{display:block;font-size:13px;color:#cbd5e1;margin-top:12px}input,textarea,select{width:100%;padding:11px 12px;margin-top:6px;background:#0b1220;border:1px solid #334155;color:white;border-radius:9px;font:inherit}textarea{min-height:150px;resize:vertical}button,.button{display:inline-block;border:0;border-radius:9px;background:var(--brand2);color:white;font-weight:700;padding:10px 14px;cursor:pointer;text-decoration:none;margin-top:10px}button.secondary,.button.secondary{background:#334155}.radio{display:flex;gap:16px;flex-wrap:wrap;margin:10px 0}.radio label{margin:0}.preview-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:10px 0}.mini{padding:10px;background:#0b1220;border-radius:8px;text-align:center;font-size:12px}.mini b{display:block;font-size:18px}table{width:100%;border-collapse:collapse;min-width:820px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:10px;font-size:12px}th{color:#c4b5fd}.scroll{overflow:auto}.badge{display:inline-block;border-radius:999px;padding:4px 8px;background:#334155}.bad{color:#fca5a5}.actions{display:flex;gap:6px;align-items:center}.actions form{margin:0}.actions button{margin:0;white-space:nowrap}.help{border-left:3px solid var(--brand);padding:10px 12px;background:#141529;color:#cbd5e1;font-size:13px;margin:12px 0}iframe{width:100%;height:360px;background:white;border:0;border-radius:10px}@media(max-width:900px){.shell{display:block}.nav{position:sticky;z-index:4;height:auto;display:flex;overflow:auto;gap:4px;padding:10px;border-right:0;border-bottom:1px solid var(--line)}.brand{display:none}.nav a{white-space:nowrap;margin:0}.main{padding:16px}.header{display:block}.notice{margin-top:12px}.stats{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}.preview-stats{grid-template-columns:repeat(2,1fr)}h1{font-size:24px}}</style></head><body><div class="shell"><nav class="nav"><div class="brand">Clarity Access</div><a href="#dashboard">Dashboard</a><a href="#contacts">Contatos</a><a href="#import">Importar base</a><a href="#campaign">Nova campanha</a><a href="#campaigns">Campanhas</a><a href="#suppressions">Supressões</a><a href="#logs">Logs/Métricas</a></nav><main class="main">
      <div class="header"><div><h1 id="dashboard">App Clarity</h1><div class="muted">Envios com consentimento, supressões preservadas e métricas oficiais do Resend.</div></div><div class="notice">${sendReady ? "Envio habilitado" : "Envio bloqueado até domínio verificado + aprovação"}</div></div>
      <section class="stats"><div class="card stat"><strong>${cs.validated}</strong><span class="muted">Base validada</span></div><div class="card stat"><strong>${cs.legacy}</strong><span class="muted">Base antiga</span></div><div class="card stat"><strong>${cs.suppressed}</strong><span class="muted">Suprimidos</span></div><div class="card stat"><strong>${ms.delivered}</strong><span class="muted">Entregues</span></div><div class="card stat"><strong>${ms.unique_clicks}</strong><span class="muted">Cliques únicos</span></div></section>
      <section class="card" id="contacts"><h2>Contatos</h2><p class="muted">As bases permanecem separadas. Campanhas novas nunca selecionam automaticamente a base antiga.</p><div class="preview-stats"><div class="mini"><b>${cs.total}</b>Total</div><div class="mini"><b>${cs.validated}</b>Validados</div><div class="mini"><b>${cs.legacy}</b>Antigos</div><div class="mini"><b>${cs.suppressed}</b>Suprimidos</div><div class="mini"><b>${cs.invalid}</b>Inválidos</div></div></section>
      <section class="grid2"><div class="card" id="import"><h2>Importar base validada</h2><p class="muted">TXT ou CSV. Deduplica e preserva hard bounce, complaint e unsubscribe.</p><form action="/import-contacts" method="post" enctype="multipart/form-data"><input type="file" name="file" accept=".txt,.csv" required><button type="submit">Importar como validada</button></form></div><div class="card"><h2>Template</h2><form action="/save-template" method="post"><label>Nome</label><input name="name" required><label>Assunto</label><input name="subject" required><label>HTML</label><textarea id="templateHtml" name="html" required></textarea><button type="button" class="secondary" onclick="preview('templateHtml')">Ver prévia</button><button type="submit">Salvar</button></form></div></section>
      <section class="grid2"><div class="card" id="campaign"><h2>Nova campanha</h2><div class="help">Abertura é aproximada por causa de proteções de privacidade. Clique e entrega têm mais peso.</div><form action="/create-campaign" method="post"><label>Template salvo</label><select id="templateSelect" onchange="loadTemplate()"><option value="">Escolher...</option>${templates.rows.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}</select><label>Nome</label><input name="name" required><label>Assunto</label><input id="campaignSubject" name="subject" required><label>HTML</label><textarea id="campaignHtml" name="html" required></textarea><label>Texto simples (opcional; gerado do HTML se vazio)</label><textarea id="campaignText" name="textContent" style="min-height:90px"></textarea><label>Destinatários</label><div class="radio"><label><input style="width:auto" type="radio" name="recipientSource" value="validated" checked onchange="toggleManual()"> Base validada</label><label><input style="width:auto" type="radio" name="recipientSource" value="manual" onchange="toggleManual()"> Colar e-mails manualmente</label></div><div id="manualBox" hidden><textarea id="manualEmails" name="manualEmails" placeholder="uma linha por e-mail, vírgulas ou ponto e vírgula" oninput="schedulePreview()"></textarea><div class="preview-stats"><div class="mini"><b id="pTotal">0</b>Total colado</div><div class="mini"><b id="pDuplicates">0</b>Duplicados</div><div class="mini"><b id="pInvalid">0</b>Inválidos</div><div class="mini"><b id="pSuppressed">0</b>Suprimidos</div><div class="mini"><b id="pEligible">0</b>Elegíveis</div></div></div><label>Limite por lote</label><input type="number" name="dailyLimit" value="30" min="1" max="500"><button type="button" class="secondary" onclick="preview('campaignHtml')">Ver prévia</button><button type="submit">Criar campanha e fila</button></form></div><div class="card"><h2>Prévia</h2><iframe id="previewFrame" sandbox=""></iframe></div></section>
      <section class="card" id="campaigns"><h2>Campanhas</h2><div class="scroll"><table><thead><tr><th>Campanha</th><th>Fonte</th><th>Fila</th><th>Enviados</th><th>Entregues</th><th>Aberturas</th><th>Únicas</th><th>Cliques</th><th>Únicos</th><th>CTR</th><th>Bounces</th><th>Complaints</th><th>Unsubs</th><th>Ação</th></tr></thead><tbody>${campaigns.rows.map(c => { const ctr = Number(c.delivered_count) ? (100 * Number(c.unique_click_count) / Number(c.delivered_count)).toFixed(1) : "0.0"; return `<tr><td>${escapeHtml(c.name)}</td><td><span class="badge">${escapeHtml(c.recipient_source)}</span></td><td>${c.total_queue}</td><td>${c.sent_count}</td><td>${c.delivered_count}</td><td>${c.open_count}</td><td>${c.unique_open_count}</td><td>${c.click_count}</td><td>${c.unique_click_count}</td><td>${ctr}%</td><td>${c.bounce_count}</td><td>${c.complaint_count}</td><td>${c.unsubscribe_count}</td><td><div class="actions"><form action="/send-batch/${c.id}" method="post"><button type="submit">Enviar lote</button></form><a class="button secondary" href="/campaigns/${c.id}/recipients">Contatos</a></div></td></tr>`; }).join("")}</tbody></table></div></section>
      <section class="card" id="suppressions"><h2>Supressões</h2><form action="/suppress" method="post"><div class="grid2"><div><label>E-mail</label><input type="email" name="email" required></div><div><label>Motivo</label><select name="reason"><option value="manual">Bloqueio manual</option><option value="unsubscribe">Unsubscribe confirmado</option><option value="invalid">Inválido</option></select></div></div><button type="submit">Suprimir sem apagar histórico</button></form><div class="scroll"><table><tr><th>E-mail</th><th>Motivo</th><th>Data</th></tr>${suppressions.rows.map(s => `<tr><td>${escapeHtml(s.email)}</td><td>${escapeHtml(s.suppression_reason || "")}</td><td>${s.suppressed_at ? new Date(s.suppressed_at).toLocaleString("pt-BR") : ""}</td></tr>`).join("")}</table></div></section>
      <section class="card" id="logs"><h2>Logs/Métricas</h2><div class="scroll"><table><tr><th>E-mail</th><th>Status</th><th>Entregue</th><th>Abriu</th><th>Clicou</th><th>Erro</th></tr>${recentLogs.rows.map(l => `<tr><td>${escapeHtml(l.email)}</td><td><span class="badge">${escapeHtml(l.status)}</span></td><td>${l.delivered_at ? "Sim" : "Não"}</td><td>${l.opened_at ? `Sim (${l.open_count})` : "Não"}</td><td>${l.clicked_at ? `Sim (${l.click_count})` : "Não"}</td><td class="bad">${escapeHtml(l.error_message || "")}</td></tr>`).join("")}</table></div></section>
      </main></div><script>const templates=${templatesJson};function preview(id){document.getElementById('previewFrame').srcdoc=document.getElementById(id).value}function loadTemplate(){const t=templates.find(x=>String(x.id)===document.getElementById('templateSelect').value);if(!t)return;document.getElementById('campaignSubject').value=t.subject;document.getElementById('campaignHtml').value=t.html;preview('campaignHtml')}function toggleManual(){document.getElementById('manualBox').hidden=document.querySelector('[name=recipientSource]:checked').value!=='manual'}let timer;function schedulePreview(){clearTimeout(timer);timer=setTimeout(async()=>{const manualEmails=document.getElementById('manualEmails').value;const response=await fetch('/preview-recipients',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({manualEmails})});if(!response.ok)return;const p=await response.json();for(const [id,key] of [['pTotal','total'],['pDuplicates','duplicates'],['pInvalid','invalid'],['pSuppressed','suppressed'],['pEligible','eligible']])document.getElementById(id).textContent=p[key]},250)}</script></body></html>`);
    } catch (error) {
      console.error(error);
      return res.status(500).send("Erro ao carregar dashboard");
    }
  });

  app.post("/preview-recipients", async (req, res) => {
    const parsed = parseEmailInput(req.body.manualEmails);
    if (!parsed.valid.length) return res.json({ total: parsed.total, duplicates: parsed.duplicates, invalid: parsed.invalid.length, suppressed: 0, eligible: 0 });
    const blocked = await pool.query(`SELECT email FROM contacts WHERE email=ANY($1::text[]) AND status IN ('suppressed','invalid')`, [parsed.valid]);
    return res.json({ total: parsed.total, duplicates: parsed.duplicates, invalid: parsed.invalid.length, suppressed: blocked.rowCount, eligible: parsed.valid.length - blocked.rowCount });
  });

  app.post("/import-contacts", upload.single("file"), async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) return res.status(400).send("Arquivo não enviado");
      const parsed = parseEmailInput(req.file.buffer.toString("utf8"));
      let inserted = 0, duplicated = 0, preservedBlocked = 0;
      for (const email of parsed.valid) {
        const existing = await pool.query(`SELECT id,status FROM contacts WHERE email=$1`, [email]);
        if (!existing.rowCount) {
          await pool.query(`INSERT INTO contacts (email,status,base_type) VALUES ($1,'active','validated')`, [email]);
          inserted += 1;
        } else {
          duplicated += 1;
          if (existing.rows[0].status !== "active") preservedBlocked += 1;
          await pool.query(`UPDATE contacts SET base_type=CASE WHEN status='active' THEN 'validated' ELSE base_type END,updated_at=NOW() WHERE id=$1`, [existing.rows[0].id]);
        }
      }
      return res.send(`<body style="background:#080b12;color:white;font-family:Arial;padding:30px"><h1>Importação concluída</h1><p>Novos: ${inserted}</p><p>Duplicados: ${duplicated}</p><p>Inválidos: ${parsed.invalid.length}</p><p>Bloqueios preservados: ${preservedBlocked}</p><a style="color:#a78bfa" href="/">Voltar</a></body>`);
    } catch (error) {
      console.error(error);
      return res.status(500).send("Erro ao importar contatos");
    }
  });

  app.post("/save-template", async (req, res) => {
    const { name, subject, html } = req.body;
    if (!name || !subject || !html) return res.status(400).send("Campos obrigatórios ausentes");
    await pool.query(`INSERT INTO templates (name,subject,html) VALUES ($1,$2,$3)`, [name, subject, html]);
    return res.redirect("/");
  });

  app.post("/create-campaign", async (req, res) => {
    const { name, subject, html, textContent, recipientSource, manualEmails } = req.body;
    const source = recipientSource === "manual" ? "manual" : "validated";
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.body.dailyLimit || "30", 10) || 30));
    if (!name || !subject || !html) return res.status(400).send("Campos obrigatórios ausentes");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const campaign = await client.query(`INSERT INTO campaigns (name,subject,html,text_content,recipient_source,daily_limit,status) VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id`, [name, subject, html, textContent || htmlToText(html), source, limit]);
      const campaignId = campaign.rows[0].id;
      if (source === "validated") {
        await client.query(`INSERT INTO email_logs (campaign_id,contact_id,email,status) SELECT $1,id,email,'pending' FROM contacts WHERE status='active' AND base_type='validated' ON CONFLICT (campaign_id,email) DO NOTHING`, [campaignId]);
      } else {
        const parsed = parseEmailInput(manualEmails);
        if (!parsed.valid.length) throw new Error("Nenhum e-mail válido foi colado");
        for (const email of parsed.valid) {
          const contact = await client.query(`INSERT INTO contacts (email,status,base_type) VALUES ($1,'active','manual') ON CONFLICT (email) DO UPDATE SET updated_at=NOW() RETURNING id,status`, [email]);
          if (contact.rows[0].status === "active") await client.query(`INSERT INTO email_logs (campaign_id,contact_id,email,status) VALUES ($1,$2,$3,'pending') ON CONFLICT (campaign_id,email) DO NOTHING`, [campaignId, contact.rows[0].id, email]);
        }
      }
      await client.query("COMMIT");
      return res.redirect("/");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      return res.status(400).send(escapeHtml(error.message));
    } finally {
      client.release();
    }
  });

  app.post("/send-batch/:id", async (req, res) => {
    if (process.env.SEND_ENABLED !== "true" || process.env.SENDER_DOMAIN_VERIFIED !== "true") return res.status(423).send("Envio bloqueado: confirme o domínio e habilite o envio somente após aprovação.");
    const required = ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO", "PUBLIC_APP_URL", "UNSUBSCRIBE_SECRET"];
    const missing = required.filter(name => !process.env[name]);
    if (missing.length) return res.status(503).send(`Configuração ausente: ${missing.join(", ")}`);
    const campaignResult = await pool.query(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
    if (!campaignResult.rowCount) return res.status(404).send("Campanha não encontrada");
    const campaign = campaignResult.rows[0];
    const claimed = await pool.query(`UPDATE email_logs SET status='processing' WHERE id IN (SELECT id FROM email_logs WHERE campaign_id=$1 AND status='pending' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`, [campaign.id, campaign.daily_limit]);
    const results = [];
    for (const item of claimed.rows) {
      try {
        const token = createUnsubscribeToken(item.email, campaign.id, process.env.UNSUBSCRIBE_SECRET);
        const unsubscribeUrl = `${process.env.PUBLIC_APP_URL.replace(/\/$/, "")}/unsubscribe?token=${encodeURIComponent(token)}`;
        const content = appendUnsubscribe(campaign.html, campaign.text_content, unsubscribeUrl);
        const response = await resend.emails.send({
          from: process.env.EMAIL_FROM, to: item.email, replyTo: process.env.EMAIL_REPLY_TO,
          subject: campaign.subject, html: content.html, text: content.text,
          headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
          tags: [{ name: "campaign_id", value: String(campaign.id) }]
        });
        if (response.error) throw new Error(response.error.message || "Resend rejected the message");
        await pool.query(`UPDATE email_logs SET status='sent',resend_id=$1,sent_at=NOW(),error_message=NULL WHERE id=$2`, [response.data.id, item.id]);
        results.push({ email: item.email, status: "accepted" });
      } catch (error) {
        await pool.query(`UPDATE email_logs SET status='error',error_message=$1 WHERE id=$2`, [error.message, item.id]);
        results.push({ email: item.email, status: "error", error: error.message });
      }
    }
    return res.send(`<body style="background:#080b12;color:white;font-family:Arial;padding:30px"><h1>Lote processado</h1><p>${results.length} item(ns).</p><a style="color:#a78bfa" href="/">Voltar</a></body>`);
  });

  app.get("/campaigns/:id/recipients", async (req, res) => {
    const campaignId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(campaignId) || campaignId < 1) return res.status(400).send("Campanha inválida");
    const allowed = ["all", "received", "opened", "clicked", "bounced"];
    const filter = allowed.includes(req.query.filter) ? req.query.filter : "all";
    const where = { all: "TRUE", received: "delivered_at IS NOT NULL", opened: "opened_at IS NOT NULL", clicked: "clicked_at IS NOT NULL", bounced: "bounced_at IS NOT NULL" }[filter];
    const rows = await pool.query(`SELECT email,status,sent_at,delivered_at,opened_at,clicked_at,bounced_at FROM email_logs WHERE campaign_id=$1 AND ${where} ORDER BY id DESC LIMIT 2000`, [campaignId]);
    return res.send(`<body style="background:#080b12;color:white;font-family:Arial;padding:24px"><h1>Contatos da campanha</h1><p><a style="color:#a78bfa" href="/campaigns/${campaignId}/recipients?filter=received">Receberam</a> · <a style="color:#a78bfa" href="/campaigns/${campaignId}/recipients?filter=opened">Abriram</a> · <a style="color:#a78bfa" href="/campaigns/${campaignId}/recipients?filter=clicked">Clicaram</a> · <a style="color:#a78bfa" href="/campaigns/${campaignId}/recipients?filter=bounced">Bounce</a></p><table style="width:100%;border-collapse:collapse">${rows.rows.map(r => `<tr><td style="padding:8px;border-bottom:1px solid #263249">${escapeHtml(r.email)}</td><td>${escapeHtml(r.status)}</td></tr>`).join("")}</table><p><a style="color:#a78bfa" href="/">Voltar</a></p></body>`);
  });

  async function suppress(email, reason, source, campaignId, evidence) {
    const normalized = cleanEmail(email);
    if (!isValidEmail(normalized)) throw new Error("E-mail inválido");
    const targetStatus = reason === "invalid" ? "invalid" : "suppressed";
    const contact = await pool.query(`INSERT INTO contacts (email,status,base_type,suppression_reason,suppressed_at,unsubscribed_at) VALUES ($1,$3,'manual',$2,NOW(),CASE WHEN $2='unsubscribe' THEN NOW() END) ON CONFLICT (email) DO UPDATE SET status=$3,suppression_reason=$2,suppressed_at=COALESCE(contacts.suppressed_at,NOW()),unsubscribed_at=CASE WHEN $2='unsubscribe' THEN COALESCE(contacts.unsubscribed_at,NOW()) ELSE contacts.unsubscribed_at END,updated_at=NOW() RETURNING id`, [normalized, reason, targetStatus]);
    await pool.query(`INSERT INTO suppression_history (contact_id,email,action,reason,source,campaign_id,evidence) VALUES ($1,$2,'suppress',$3,$4,$5,$6::jsonb)`, [contact.rows[0].id, normalized, reason, source, campaignId || null, JSON.stringify(evidence || {})]);
    if (campaignId) await pool.query(`UPDATE email_logs SET unsubscribed_at=CASE WHEN $1='unsubscribe' THEN COALESCE(unsubscribed_at,NOW()) ELSE unsubscribed_at END WHERE campaign_id=$2 AND email=$3`, [reason, campaignId, normalized]);
  }

  app.post("/suppress", async (req, res) => {
    try {
      await suppress(req.body.email, req.body.reason || "manual", "admin", null, {});
      return res.redirect("/#suppressions");
    } catch (error) {
      return res.status(400).send(escapeHtml(error.message));
    }
  });
  app.get("/unsubscribe", async (req, res) => {
    const data = verifyUnsubscribeToken(req.query.token, process.env.UNSUBSCRIBE_SECRET);
    if (!data) return res.status(400).send("Link inválido");
    return res.send(`<body style="font-family:Arial;background:#f8fafc;color:#111827;padding:30px;max-width:600px;margin:auto"><h1>Cancelar inscrição</h1><p>Confirme para não receber novas campanhas da Clarity Access.</p><form method="post" action="/unsubscribe"><input type="hidden" name="token" value="${escapeHtml(req.query.token)}"><button style="padding:12px 18px;background:#6d28d9;color:white;border:0;border-radius:8px">Cancelar inscrição</button></form></body>`);
  });
  app.post("/unsubscribe", async (req, res) => {
    const data = verifyUnsubscribeToken(req.body.token || req.query.token, process.env.UNSUBSCRIBE_SECRET);
    if (!data) return res.status(400).send("Link inválido");
    await suppress(data.email, "unsubscribe", "recipient", data.campaignId, { oneClick: req.get("list-unsubscribe") === "One-Click" });
    return res.status(200).send("Inscrição cancelada com sucesso.");
  });

  // Historical links remain functional; new messages never use these endpoints.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
  app.get("/open/:id.png", async (req, res) => {
    await pool.query(`UPDATE email_logs SET opened_at=COALESCE(opened_at,NOW()) WHERE id=$1`, [req.params.id]).catch(() => {});
    return res.set({ "Content-Type": "image/png", "Cache-Control": "no-store" }).send(pixel);
  });
  app.get("/click/:id", async (req, res) => {
    const url = String(req.query.url || "");
    const legacyOrigins = new Set(["https://smsgrab.lovable.app", "https://teleggrab.lovable.app", "https://whatsgrab.lovable.app", "https://snap-radar-pro.lovable.app", "https://apptinder.lovable.app", "https://galeria.fabricadeaplicativos.com.br"]);
    let destination;
    try { destination = new URL(url); } catch { return res.status(400).send("Invalid URL"); }
    if (!legacyOrigins.has(destination.origin)) return res.status(400).send("Invalid URL");
    await pool.query(`UPDATE email_logs SET clicked_at=COALESCE(clicked_at,NOW()) WHERE id=$1`, [req.params.id]).catch(() => {});
    return res.redirect(destination.toString());
  });
  app.get("/health", (req, res) => res.json({ ok: true, sendingEnabled: process.env.SEND_ENABLED === "true" && process.env.SENDER_DOMAIN_VERIFIED === "true" }));
  return app;
}

if (require.main === module) {
  const dependencies = createDependencies();
  initDatabase(dependencies.pool)
    .then(() => createApp(dependencies).listen(process.env.PORT || 3000, () => console.log("App Clarity online")))
    .catch(error => { console.error("Database init error", error); process.exit(1); });
}

module.exports = { createApp, createDependencies, initDatabase, processResendWebhook };
