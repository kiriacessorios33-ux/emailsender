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

const FALLBACK_URL = "https://smsgrab.lovable.app";

const TRANSPARENT_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

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

function isAllowedUrl(url) {
  return ALLOWED_LINKS.some(function(allowedLink) {
    return String(url || "").startsWith(allowedLink);
  });
}

function addTrackingToHtml(html, logId) {
  let modifiedHtml = String(html || "");

  modifiedHtml = modifiedHtml.replace(
    /href=(["'])(.*?)\1/gi,
    function(match, quote, originalUrl) {
      if (!isAllowedUrl(originalUrl)) {
        return match;
      }

      const trackingUrl =
        APP_URL +
        "/click/" +
        encodeURIComponent(logId) +
        "?url=" +
        encodeURIComponent(originalUrl);

      return "href=" + quote + trackingUrl + quote;
    }
  );

  const pixel =
    '<img src="' +
    APP_URL +
    "/open/" +
    encodeURIComponent(logId) +
    '.png" width="1" height="1" style="display:none;opacity:0;width:1px;height:1px;" alt="" />';

  if (/<\/body>/i.test(modifiedHtml)) {
    modifiedHtml = modifiedHtml.replace(/<\/body>/i, pixel + "</body>");
  } else {
    modifiedHtml += pixel;
  }

  return modifiedHtml;
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

app.get("/click/:id", async (req, res) => {
  try {
    const logId = req.params.id;
    const originalUrl = String(req.query.url || "");

    if (!isAllowedUrl(originalUrl)) {
      return res.redirect(FALLBACK_URL);
    }

    await pool.query(
      `
      UPDATE email_logs
      SET clicked_at = COALESCE(clicked_at, NOW()),
          opened_at = COALESCE(opened_at, NOW())
      WHERE id = $1
      `,
      [logId]
    );

    return res.redirect(originalUrl);
  } catch (error) {
    console.error("Click tracking error:", error);
    return res.redirect(FALLBACK_URL);
  }
});

app.get("/open/:id.png", async (req, res) => {
  try {
    const logId = req.params.id;

    await pool.query(
      `
      UPDATE email_logs
      SET opened_at = COALESCE(opened_at, NOW())
      WHERE id = $1
      `,
      [logId]
    );
  } catch (error) {
    console.error("Open tracking error:", error);
  }

  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.send(TRANSPARENT_PIXEL);
});

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
  const errorsTotal = await pool.query(`SELECT COUNT(*) FROM email_logs WHERE status = 'error'`);
  const openedTotal = await pool.query(`SELECT COUNT(*) FROM email_logs WHERE opened_at IS NOT NULL`);
  const clickedTotal = await pool.query(`SELECT COUNT(*) FROM email_logs WHERE clicked_at IS NOT NULL`);

  const campaigns = await pool.query(`
    SELECT
      c.*,
      COUNT(l.id) AS total_queue,
      COUNT(l.id) FILTER (WHERE l.status = 'pending') AS pending_count,
      COUNT(l.id) FILTER (WHERE l.status = 'sent') AS sent_count,
      COUNT(l.id) FILTER (WHERE l.status = 'error') AS error_count,
      COUNT(l.id) FILTER (WHERE l.opened_at IS NOT NULL) AS open_count,
      COUNT(l.id) FILTER (WHERE l.clicked_at IS NOT NULL) AS click_count
    FROM campaigns c
    LEFT JOIN email_logs l ON l.campaign_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
    LIMIT 20
  `);

  const templates = await pool.query(`
    SELECT * FROM templates
    ORDER BY created_at DESC
  `);

  const recentLogs = await pool.query(`
    SELECT * FROM email_logs
    ORDER BY created_at DESC
    LIMIT 30
  `);

  const templatesJson = JSON.stringify(templates.rows).replaceAll("<", "\\u003c");

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>App Clarity Dashboard</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#0b0b12;color:#fff;font-family:Arial,sans-serif}
    .layout{display:flex;min-height:100vh}
    .sidebar{width:260px;background:#11111d;padding:25px;border-right:1px solid #24243a;position:fixed;top:0;bottom:0;left:0}
    .sidebar h2{margin-top:0;color:#a78bfa}
    .sidebar a{display:block;color:#ddd;text-decoration:none;padding:12px;border-radius:10px;margin-bottom:8px;background:#181827}
    .main{margin-left:260px;width:calc(100% - 260px);padding:30px}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin-bottom:30px}
    .card{background:#161625;border:1px solid #292945;border-radius:16px;padding:20px;margin-bottom:20px}
    .stat{font-size:28px;font-weight:bold;margin-bottom:5px}
    .muted{color:#aaa;font-size:14px}
    input,textarea,select{width:100%;padding:13px;margin-top:8px;margin-bottom:15px;background:#0f0f1a;border:1px solid #33334f;color:white;border-radius:10px;font-size:14px}
    textarea{min-height:180px;font-family:monospace}
    button{background:#7c3aed;color:white;border:none;padding:12px 18px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:bold;margin:2px}
    button.secondary{background:#292945}
    table{width:100%;border-collapse:collapse;margin-top:15px}
    th,td{padding:12px;border-bottom:1px solid #292945;text-align:left;font-size:14px}
    th{color:#a78bfa}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    iframe{width:100%;height:380px;background:white;border:none;border-radius:12px}
    .badge{padding:5px 9px;border-radius:999px;font-size:12px;background:#33334f;display:inline-block}
    .success{background:#166534}
    .pending{background:#92400e}
    .error{background:#991b1b}
  </style>
</head>

<body>
<div class="layout">
  <div class="sidebar">
    <h2>App Clarity</h2>
    <a href="#dashboard">Dashboard</a>
    <a href="#importar">Importar Lista</a>
    <a href="#template">Templates HTML</a>
    <a href="#campanha">Criar Campanha</a>
    <a href="#campanhas">Campanhas</a>
    <a href="#logs">Logs</a>
  </div>

  <div class="main">
    <h1 id="dashboard">Dashboard</h1>
    <p class="muted">Painel profissional da sua plataforma de email marketing.</p>

    <div class="grid">
      <div class="card"><div class="stat">${contactsTotal.rows[0].count}</div><div class="muted">Contatos salvos</div></div>
      <div class="card"><div class="stat">${campaignsTotal.rows[0].count}</div><div class="muted">Campanhas</div></div>
      <div class="card"><div class="stat">${pendingTotal.rows[0].count}</div><div class="muted">Pendentes</div></div>
      <div class="card"><div class="stat">${sentToday.rows[0].count}</div><div class="muted">Enviados hoje</div></div>
      <div class="card"><div class="stat">${sentTotal.rows[0].count}</div><div class="muted">Total enviados</div></div>
      <div class="card"><div class="stat">${errorsTotal.rows[0].count}</div><div class="muted">Erros</div></div>
      <div class="card"><div class="stat">${openedTotal.rows[0].count}</div><div class="muted">Aberturas</div></div>
      <div class="card"><div class="stat">${clickedTotal.rows[0].count}</div><div class="muted">Cliques</div></div>
    </div>

    <div class="card" id="importar">
      <h2>Importar Lista de Emails</h2>
      <p class="muted">Suba seus contatos uma vez. Depois você pode importar novos emails todos os dias. O sistema ignora duplicados.</p>
      <form action="/import-contacts" method="POST" enctype="multipart/form-data">
        <label>Arquivo TXT ou CSV</label>
        <input type="file" name="file" accept=".txt,.csv" required>
        <button type="submit">Importar Contatos</button>
      </form>
    </div>

    <div class="row">
      <div class="card" id="template">
        <h2>Salvar Template HTML</h2>
        <form action="/save-template" method="POST">
          <label>Nome do Template</label>
          <input type="text" name="name" placeholder="Ex: Oferta Principal" required>

          <label>Assunto padrão</label>
          <input type="text" name="subject" placeholder="Ex: Oferta especial" required>

          <label>HTML do Email</label>
          <textarea id="templateHtml" name="html" placeholder="<h1>Sua oferta</h1>" required></textarea>

          <button type="button" onclick="previewTemplate()">Ver Prévia</button>
          <button type="submit">Salvar Template</button>
        </form>
      </div>

      <div class="card">
        <h2>Prévia do Email</h2>
        <iframe id="previewFrame"></iframe>
      </div>
    </div>

    <div class="card" id="campanha">
      <h2>Criar Campanha</h2>
      <p class="muted">A campanha cria uma fila com os contatos ativos. Depois você envia por lote.</p>

      <form action="/create-campaign" method="POST">
        <label>Usar template salvo</label>
        <select id="templateSelect" onchange="loadTemplate()">
          <option value="">Escolher template...</option>
          ${templates.rows.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}
        </select>

        <label>Nome da Campanha</label>
        <input type="text" name="name" placeholder="Ex: Campanha Maio" required>

        <label>Assunto</label>
        <input id="campaignSubject" type="text" name="subject" required>

        <label>HTML do Email</label>
        <textarea id="campaignHtml" name="html" required></textarea>

        <label>Limite por lote</label>
        <input type="number" name="dailyLimit" value="30" min="1">

        <button type="button" onclick="previewCampaign()">Ver Prévia</button>
        <button type="submit">Criar Campanha e Fila</button>
      </form>
    </div>

    <div class="card" id="campanhas">
      <h2>Campanhas</h2>
      <table>
        <tr>
          <th>Campanha</th>
          <th>Status</th>
          <th>Total</th>
          <th>Pendentes</th>
          <th>Enviados</th>
          <th>Erros</th>
          <th>Aberturas</th>
          <th>Cliques</th>
          <th>Ação</th>
        </tr>
        ${campaigns.rows.map(c => `
          <tr>
            <td>${escapeHtml(c.name)}</td>
            <td><span class="badge">${escapeHtml(c.status)}</span></td>
            <td>${c.total_queue}</td>
            <td>${c.pending_count}</td>
            <td>${c.sent_count}</td>
            <td>${c.error_count}</td>
            <td>${c.open_count}</td>
            <td>${c.click_count}</td>
            <td>
              <form action="/send-batch/${c.id}" method="POST" style="display:inline;">
                <button type="submit">Enviar lote</button>
              </form>
              <form action="/add-new-to-campaign/${c.id}" method="POST" style="display:inline;">
                <button class="secondary" type="submit">Add novos</button>
              </form>
            </td>
          </tr>
        `).join("")}
      </table>
    </div>

    <div class="card" id="logs">
      <h2>Últimos Envios</h2>
      <table>
        <tr>
          <th>Email</th>
          <th>Status</th>
          <th>Abriu?</th>
          <th>Clicou?</th>
          <th>Erro</th>
          <th>Data</th>
        </tr>
        ${recentLogs.rows.map(log => `
          <tr>
            <td>${escapeHtml(log.email)}</td>
            <td><span class="badge ${
              log.status === "sent" ? "success" :
              log.status === "pending" ? "pending" :
              log.status === "error" ? "error" : ""
            }">${escapeHtml(log.status)}</span></td>
            <td>${log.opened_at ? "Sim" : "Não"}</td>
            <td>${log.clicked_at ? "Sim" : "Não"}</td>
            <td>${escapeHtml(log.error_message || "")}</td>
            <td>${log.created_at ? new Date(log.created_at).toLocaleString("pt-BR") : ""}</td>
          </tr>
        `).join("")}
      </table>
    </div>
  </div>
</div>

<script>
  const templates = ${templatesJson};

  function previewTemplate() {
    const html = document.getElementById("templateHtml").value;
    document.getElementById("previewFrame").srcdoc = html;
  }

  function previewCampaign() {
    const html = document.getElementById("campaignHtml").value;
    document.getElementById("previewFrame").srcdoc = html;
  }

  function loadTemplate() {
    const id = document.getElementById("templateSelect").value;
    const selected = templates.find(function(t) {
      return String(t.id) === String(id);
    });

    if (!selected) return;

    document.getElementById("campaignSubject").value = selected.subject;
    document.getElementById("campaignHtml").value = selected.html;
    document.getElementById("previewFrame").srcdoc = selected.html;
  }
</script>

</body>
</html>
  `);
});

app.post("/import-contacts", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).send("Nenhum arquivo enviado");
    }

    const fileContent = req.file.buffer.toString("utf-8");

    const emails = fileContent
      .split(/\r?\n|,|;/)
      .map(cleanEmail)
      .filter(isValidEmail);

    const uniqueEmails = [...new Set(emails)];

    let inserted = 0;
    let duplicated = 0;

    for (const email of uniqueEmails) {
      const result = await pool.query(
        `
        INSERT INTO contacts (email)
        VALUES ($1)
        ON CONFLICT (email) DO NOTHING
        RETURNING id
        `,
        [email]
      );

      if (result.rows.length > 0) inserted++;
      else duplicated++;
    }

    res.send(`
      <body style="background:#111;color:white;font-family:Arial;padding:40px;">
        <h1>Importação finalizada</h1>
        <p>Novos contatos: ${inserted}</p>
        <p>Duplicados ignorados: ${duplicated}</p>
        <p>Total lido no arquivo: ${uniqueEmails.length}</p>
        <a style="color:#a78bfa;" href="/">Voltar ao painel</a>
      </body>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao importar contatos");
  }
});

app.post("/save-template", async (req, res) => {
  try {
    const { name, subject, html } = req.body;

    await pool.query(
      `
      INSERT INTO templates (name, subject, html)
      VALUES ($1, $2, $3)
      `,
      [name, subject, html]
    );

    res.redirect("/");
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao salvar template");
  }
});

app.post("/create-campaign", async (req, res) => {
  try {
    const { name, subject, html, dailyLimit } = req.body;

    const campaignResult = await pool.query(
      `
      INSERT INTO campaigns (name, subject, html, daily_limit, status)
      VALUES ($1, $2, $3, $4, 'active')
      RETURNING id
      `,
      [name, subject, html, parseInt(dailyLimit || "30")]
    );

    const campaignId = campaignResult.rows[0].id;

    await pool.query(
      `
      INSERT INTO email_logs (campaign_id, contact_id, email, status)
      SELECT $1, id, email, 'pending'
      FROM contacts
      WHERE status = 'active'
      ON CONFLICT (campaign_id, email) DO NOTHING
      `,
      [campaignId]
    );

    res.redirect("/");
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao criar campanha");
  }
});

app.post("/add-new-to-campaign/:id", async (req, res) => {
  try {
    const campaignId = req.params.id;

    await pool.query(
      `
      INSERT INTO email_logs (campaign_id, contact_id, email, status)
      SELECT $1, id, email, 'pending'
      FROM contacts
      WHERE status = 'active'
      ON CONFLICT (campaign_id, email) DO NOTHING
      `,
      [campaignId]
    );

    res.redirect("/");
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao adicionar novos contatos");
  }
});
app.post("/send-batch/:id", async (req, res) => {
  try {
    const campaignId = req.params.id;

    const campaignResult = await pool.query(
      `SELECT * FROM campaigns WHERE id = $1`,
      [campaignId]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).send("Campanha não encontrada");
    }

    const campaign = campaignResult.rows[0];

    const pendingResult = await pool.query(
      `
      SELECT *
      FROM email_logs
      WHERE campaign_id = $1
      AND status = 'pending'
      ORDER BY id ASC
      LIMIT $2
      `,
      [campaignId, campaign.daily_limit]
    );

    const pending = pendingResult.rows;
    const results = [];

    for (const item of pending) {
      try {
        const trackedHtml = addTrackingToHtml(campaign.html, item.id);

        const data = await resend.emails.send({
          from: FROM_EMAIL,
          to: item.email,
          replyTo: REPLY_TO_EMAIL,
          subject: campaign.subject,
          html: trackedHtml
        });

        await pool.query(
          `
          UPDATE email_logs
          SET status = 'sent',
              resend_id = $1,
              sent_at = NOW(),
              error_message = NULL
          WHERE id = $2
          `,
          [data.id, item.id]
        );

        results.push({
          email: item.email,
          status: "sent",
          id: data.id
        });

        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (error) {
        await pool.query(
          `
          UPDATE email_logs
          SET status = 'error',
              error_message = $1
          WHERE id = $2
          `,
          [error.message, item.id]
        );

        results.push({
          email: item.email,
          status: "error",
          error: error.message
        });
      }
    }

    res.send(`
      <body style="background:#111;color:white;font-family:Arial;padding:40px;">
        <h1>Lote enviado</h1>
        <p>Campanha: ${escapeHtml(campaign.name)}</p>
        <p>Total processado: ${results.length}</p>

        <pre style="background:#222;padding:20px;border-radius:10px;white-space:pre-wrap;">
${escapeHtml(JSON.stringify(results, null, 2))}
        </pre>

        <a style="color:#a78bfa;" href="/">Voltar ao painel</a>
      </body>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao enviar lote");
  }
});

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("App Clarity email dashboard online");
    });
  })
  .catch(error => {
    console.error("Database init error:", error);
    process.exit(1);
  });
