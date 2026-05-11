import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  ADMIN_SECRET
} = process.env;

function requireAdminSecret(req, res, next) {
  const secret = req.query.secret;

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({
      error: "Accesso non autorizzato"
    });
  }

  next();
}

async function getShopifyAccessToken() {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data.access_token;
}

async function shopifyGraphql(query, variables = {}) {
  const accessToken = await getShopifyAccessToken();

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

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

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    app: "shopify-seo-generator"
  });
});

app.get("/auth/callback", (req, res) => {
  res.send("Callback Shopify ricevuta correttamente.");
});

app.get("/admin/test-shopify-token", requireAdminSecret, async (req, res) => {
  try {
    const token = await getShopifyAccessToken();

    res.json({
      status: "ok",
      message: "Token Shopify ottenuto correttamente",
      token_preview: `${token.slice(0, 8)}...`
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Errore nel recupero token Shopify",
      details: error.message
    });
  }
});

app.get("/admin/test-create-page", requireAdminSecret, async (req, res) => {
  try {
    const mutation = `
      mutation CreatePage($page: PageCreateInput!) {
        pageCreate(page: $page) {
          page {
            id
            title
            handle
            isPublished
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      page: {
        title: "Pagina test SEO Generator",
        handle: `pagina-test-seo-generator-${Date.now()}`,
        body: "<h1>Pagina test SEO Generator</h1><p>Questa è una pagina di test creata automaticamente dall'app SEO Page Generator.</p>",
        isPublished: false
      }
    };

    const data = await shopifyGraphql(mutation, variables);

    res.json({
      status: "ok",
      message: "Test creazione pagina eseguito",
      result: data
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Errore nella creazione pagina Shopify",
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`App attiva sulla porta ${PORT}`);
});
