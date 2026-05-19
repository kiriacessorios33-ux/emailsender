const express = require("express");
const { Resend } = require("resend");
const multer = require("multer");

const app = express();

const upload = multer({ storage: multer.memoryStorage() });

app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

const resend = new Resend(process.env.RESEND_API_KEY);

app.get("/", (req, res) => {
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
          max-width:900px;
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

        h1{
          margin-bottom:30px;
        }

        .info{
          color:#aaa;
          margin-bottom:20px;
        }

      </style>

    </head>

    <body>

      <div class="box">

        <h1>Bulk Email Sender</h1>

        <div class="info">
          Importe TXT ou CSV com emails.
        </div>

        <form action="/send-bulk" method="POST" enctype="multipart/form-data">

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

          <label>Quantidade para enviar:</label>

          <input
            type="number"
            name="limit"
            value="30"
          />

          <button type="submit">
            Iniciar Disparo
          </button>

        </form>

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
      .map(email => email.trim())
      .filter(email => email.includes("@"));

    const subject = req.body.subject;
    const html = req.body.html;

    const limit = parseInt(req.body.limit || "30");

    const results = [];

    for(let i = 0; i < Math.min(limit, emails.length); i++){

      const to = emails[i];

      try {

        const data = await resend.emails.send({

          from: "Suporte <onboarding@resend.dev>",

          to,

          subject,

          html

        });

        results.push({
          email: to,
          status: "sent",
          id: data.id
        });

        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch(error){

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

          <p>Total processado: ${results.length}</p>

          <pre style="background:#222;padding:20px;border-radius:10px;">
${JSON.stringify(results, null, 2)}
          </pre>

          <a href="/" style="color:#8b5cf6;">
            Voltar
          </a>

        </body>

      </html>

    `);

  } catch(error){

    console.log(error);

    res.status(500).send("Erro no disparo");

  }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log("Bulk sender online");

});
