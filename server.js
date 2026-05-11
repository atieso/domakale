import express from "express";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SEO Page Generator</title>
      </head>
      <body style="font-family: Arial, sans-serif; padding: 40px;">
        <h1>SEO Page Generator attivo</h1>
        <p>L'app è online e raggiungibile da Shopify.</p>
      </body>
    </html>
  `);
});

app.get("/auth/callback", (req, res) => {
  res.send("Callback Shopify ricevuta correttamente.");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    app: "shopify-seo-generator"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`App attiva sulla porta ${PORT}`);
});
