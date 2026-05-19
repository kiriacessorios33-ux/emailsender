const express = require("express");
const { Resend } = require("resend");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

const resend = new Resend(process.env.RESEND_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      html TEXT NOT NULL,
      total_contacts INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES campaigns(id),
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      resend_id TEXT,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("Database ready");
}

initDatabase().catch(error => {
  console.error("Database error:", error);
});

app.get("/", async (req, res) => {
  const campaignsResult = await pool.query(`
    SELECT *
    FROM campaigns
    ORDER BY created_at DESC
    LIMIT 10
  `);

  const campaigns = campaignsResult.rows;

  res.send(`
  <html>
    <head>
      <title>Bulk Email Sender</title>

      <style>
        body{
          background:#111;
          color:white;
          font-family:Arial;
          padding:40px;
        }

        .box{
          max-width:1000px;
          margin:auto;
        }

        input, textarea{
          width:100%;
          padding:12px;
          margin-top:10px;
          margin-bottom:20px;
          border:none;
          border-radius:10px;
          font-size:15px;
        }

        button{
          background:#7c3aed;
          color:white;
          border:none;
          padding:15px 25px;
          border-radius:10px;
          cursor:pointer;
          font-size:16px;
        }

        h1, h2{
          margin-bottom:20px;
        }

        .info{
          color:#aaa;
          margin-bottom:20px;
        }

        .card{
          background:#1f1f1f;
          padding:20px;
          border-radius:12px;
          margin-bottom:15px;
        }

        .stats{
          display:flex;
          gap:15px;
          flex-wrap:wrap;
        }

        .stat{
          background:#222;
          padding:15px;
          border-radius:10px;
          min-width:120px;
        }

        .small{
          color:#aaa;
          font-size:13px;
        }
      </style>
    </head>

    <body>
      <div class="box">
        <h1>Bulk Email Sender</h1>

        <div class="info">
          Importe TXT ou CSV com emails. O sistema agora salva campanha, contatos e logs no PostgreSQL.
        </div>

        <form action="/send-bulk" method="POST" enctype="multipart/form-data">
          <label>Nome da Campanha:</label>
          <input
            type="text"
            name="campaignName"
            placeholder="Ex: Campanha Black Friday"
            required
          />

          <label>Arquivo TXT ou CSV:</label>
          <input
            type="file"
            name="file"
            accept=".txt,.csv"
            required
          />

          <label>Assunto:</label>
          <input
            type="text"
            name="subject"
            placeholder="Assunto do email"
            required
          />

          <label>HTML do Email:</label>
          <textarea
            name="html"
            rows="15"
            placeholder="<h1>Promoção</h1>"
            required
          ></textarea>

          <label>Quantidade para enviar agora:</label>
          <input
            type="number"
            name="limit"
            value="30"
          />

          <button type="submit">
            Iniciar Disparo
          </button>
        </form>

        <h2>Últimas Campanhas</h2>

        ${
          campaigns.length === 0
            ? `<p class="small">Nenhuma campanha criada ainda.</p>`
            : campaigns.map(campaign => `
              <div class="card">
                <h3>${campaign.name}</h3>
                <p class="small">Assunto: ${campaign.subject}</p>

                <div class="stats">
                  <div class="stat">
                    <strong>${campaign.total_contacts}</strong><br>
                    <span class="small">Contatos</span>
                  </div>

                  <div class="stat">
                    <strong>${campaign.sent_count}</strong><br>
                    <span class="small">Enviados</span>
                  </div>

                  <div class="stat">
                    <strong>${campaign.error_count}</strong><br>
                    <span class="small">Erros</span>
                  </div>
                </div>
              </div>
            `).join("")
        }
      </div>
    </body>
  </html>
  `);
});

app.post("/send-bulk", upload.single("file"), async (req, res) => {
  try {
    const fileContent = req.file.buffer.toString("utf-8");

    const emails = fileContent
      .split(/\r?\n|,/)
      .map(email => email.trim().toLowerCase())
      .filter(email => email.includes("@"));

    const uniqueEmails = [...new Set(emails)];

    const campaignName = req.body.campaignName;
    const subject = req.body.subject;
    const html = req.body.html;
    const limit = parseInt(req.body.limit || "30");

    const campaignResult = await pool.query(
      `
      INSERT INTO campaigns (name, subject, html, total_contacts)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [campaignName, subject, html, uniqueEmails.length]
    );

    const campaignId = campaignResult.rows[0].id;

    for (const email of uniqueEmails) {
      await pool.query(
        `
        INSERT INTO contacts (email)
        VALUES ($1)
        ON CONFLICT (email) DO NOTHING
        `,
        [email]
      );
    }

    const results = [];

    for (let i = 0; i < Math.min(limit, uniqueEmails.length); i++) {
      const to = uniqueEmails[i];

      try {
        const data = await resend.emails.send({
          from: "Suporte <onboarding@resend.dev>",
          to,
          subject,
          html
        });

        await pool.query(
          `
          INSERT INTO email_logs (campaign_id, email, status, resend_id)
          VALUES ($1, $2, $3, $4)
          `,
          [campaignId, to, "sent", data.id]
        );

        await pool.query(
          `
          UPDATE campaigns
          SET sent_count = sent_count + 1
          WHERE id = $1
          `,
          [campaignId]
        );

        results.push({
          email: to,
          status: "sent",
          id: data.id
        });

        await new Promise(resolve => setTimeout(resolve, 1500));
      } catch (error) {
        await pool.query(
          `
          INSERT INTO email_logs (campaign_id, email, status, error_message)
          VALUES ($1, $2, $3, $4)
          `,
          [campaignId, to, "error", error.message]
        );

        await pool.query(
          `
          UPDATE campaigns
          SET error_count = error_count + 1
          WHERE id = $1
          `,
          [campaignId]
        );

        results.push({
          email: to,
          status: "error",
          error: error.message
        });
      }
    }

    res.send(`
      <html>
        <body style="background:#111;color:white;font-family:Arial;padding:40px;">
          <h1>Disparo Finalizado</h1>

          <p>Campanha criada: ${campaignName}</p>
          <p>Total importado: ${uniqueEmails.length}</p>
          <p>Total processado agora: ${results.length}</p>

          <pre style="background:#222;padding:20px;border-radius:10px;">
${JSON.stringify(results, null, 2)}
          </pre>

          <a href="/" style="color:#8b5cf6;">
            Voltar
          </a>
        </body>
      </html>
    `);
  } catch (error) {
    console.log(error);
    res.status(500).send("Erro no disparo");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Bulk sender online");
});
