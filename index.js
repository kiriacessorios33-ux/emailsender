const express = require("express");
const { Resend } = require("resend");

const app = express();

app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

app.get("/", (req, res) => {
  res.send("Email sender online");
});

app.post("/send", async (req, res) => {
  try {
    const { to, subject, html } = req.body;

    const data = await resend.emails.send({
      from: "Suporte <onboarding@resend.dev>",
      to,
      subject,
      html
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
