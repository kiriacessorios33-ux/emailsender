const express = require("express");
const { Resend } = require("resend");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Email Sender</title>
        <style>
          body{
            font-family: Arial;
            background:#111;
            color:white;
            padding:40px;
          }

          input, textarea{
            width:100%;
            padding:12px;
            margin-top:10px;
            margin-bottom:20px;
            border:none;
            border-radius:8px;
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

          .box{
            max-width:700px;
            margin:auto;
          }
        </style>
      </head>

      <body>
        <div class="box">
          <h1>Email Sender</h1>

          <form action="/send" method="POST">

            <input
              type="email"
              name="to"
              placeholder="Email do cliente"
              required
            />

            <input
              type="text"
              name="subject"
              placeholder="Assunto"
              required
            />

            <textarea
              name="html"
              placeholder="Conteúdo do email"
              rows="10"
              required
            ></textarea>

            <button type="submit">
              Enviar Email
            </button>

          </form>
        </div>
      </body>
    </html>
  `);
});

app.post("/send", async (req, res) => {
  try {

    const { to, subject, html } = req.body;

    await resend.emails.send({
      from: "Suporte <onboarding@resend.dev>",
      to,
      subject,
      html
    });

    res.send("Email enviado com sucesso!");

  } catch (error) {

    console.log(error);

    res.status(500).send("Erro ao enviar email");

  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running");
});
