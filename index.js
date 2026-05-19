const express = require("express");
const { Resend } = require("resend");

const app = express();
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

const resend = new Resend(process.env.RESEND_API_KEY);

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Email Sender</title>
        <style>
          body { font-family: Arial; background:#111; color:white; padding:40px; }
          .box { max-width:850px; margin:auto; }
          input, textarea {
            width:100%; padding:12px; margin:10px 0 20px;
            border:none; border-radius:8px; font-size:15px;
          }
          button {
            background:#7c3aed; color:white; border:none;
            padding:15px 25px; border-radius:10px; cursor:pointer; font-size:16px;
          }
          small { color:#bbb; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Bulk Email Sender</h1>

          <form action="/send-bulk" method="POST">
            <label>Emails dos clientes, um por linha:</label>
            <textarea name="emails" rows="8" placeholder="cliente1@gmail.com&#10;cliente2@hotmail.com" required></textarea>

            <label>Assunto:</label>
            <input name="subject" placeholder="Assunto do email" required />

            <label>HTML do email:</label>
            <textarea name="html" rows="14" placeholder="<h1>Seu relatório está pronto</h1><p>Clique abaixo...</p>" required></textarea>

            <label>Limite de envio agora:</label>
            <input name="limit" value="30" />

            <small>Recomendado no início: 20 a 50 por disparo.</small>
            <br><br>

            <button type="submit">Enviar Disparo</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post("/send-bulk", async (req, res) => {
  const { emails, subject, html, limit } = req.body;

  const list = emails
    .split(/\r?\n/)
    .map(e => e.trim())
    .filter(e => e.includes("@"));

  const max = Math.min(parseInt(limit || "30"), list.length);

  const results = [];

  for (let i = 0; i < max; i++) {
    const to = list[i];

    try {
      const data = await resend.emails.send({
        from: "Clarity Notify <notify@claritynotify.online>",
        to,
        subject,
        html: `
          ${html}
          <br><br>
          <hr>
          <p style="font-size:12px;color:#777;">
            You are receiving this email because you requested or interacted with our service.
          </p>
        `
      });

      results.push({ email: to, status: "sent", id: data.id });

      await new Promise(resolve => setTimeout(resolve, 1500));

    } catch (error) {
      results.push({ email: to, status: "error", error: error.message });
    }
  }

  res.send(`
    <html>
      <body style="font-family:Arial;background:#111;color:white;padding:40px;">
        <h1>Disparo finalizado</h1>
        <p>Total processado: ${results.length}</p>
        <pre style="background:#222;padding:20px;border-radius:10px;">${JSON.stringify(results, null, 2)}</pre>
        <a href="/" style="color:#a78bfa;">Voltar</a>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Bulk email sender running");
});
