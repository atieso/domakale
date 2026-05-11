import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json());

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_ADMIN_ACCESS_TOKEN,
  ADMIN_SECRET
} = process.env;

const SCOPES = [
  "read_content",
  "write_content",
  "read_online_store_pages",
  "write_online_store_pages",
  "read_products"
].join(",");

const APP_URL = "https://domakale.onrender.com";

function cleanShop(shop) {
  return String(shop || "")
    .replace("https://", "")
    .replace("http://", "")
    .replace("/", "")
    .trim()
    .toLowerCase();
}

function requireAdminSecret(req, res, next) {
  const secret = req.query.secret;

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({
      error: "Accesso non autorizzato"
    });
  }

  next();
}

function verifyShopifyHmac(query) {
  const { hmac, signature, ...rest } = query;

  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(",") : rest[key]}`)
    .join("&");

  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(generatedHash, "utf8"),
    Buffer.from(hmac, "utf8")
  );
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
        <p>Per installare l'app su Shopify:</p>
        <p>
          <a href="/auth?shop=${SHOPIFY_STORE_DOMAIN}">
            Installa su ${SHOPIFY_STORE_DOMAIN}
          </a>
        </p>
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

app.get("/auth", (req, res) => {
  const shop = cleanShop(req.query.shop || SHOPIFY_STORE_DOMAIN);

  if (!shop || !shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Parametro shop non valido.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/auth/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(SHOPIFY_CLIENT_ID)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  res.redirect(installUrl);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { shop, code } = req.query;

    if (!shop || !code) {
      return res.status(400).send("Callback non valida: shop o code mancanti.");
    }

    if (!verifyShopifyHmac(req.query)) {
      return res.status(400).send("HMAC Shopify non valido.");
    }

    const cleanShopDomain = cleanShop(shop);

    const response = await fetch(`https://${cleanShopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      })
    });

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      return res.status(500).json({
        status: "error",
        message: "Errore nello scambio code/token",
        response: data
      });
    }

    res.send(`
      <html>
        <head>
          <title>Token Shopify ottenuto</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 40px;">
          <h1>Token Shopify ottenuto correttamente</h1>
          <p>Copia questo valore e inseriscilo su Render come variabile ambiente:</p>
          <h3>SHOPIFY_ADMIN_ACCESS_TOKEN</h3>
          <textarea style="width: 100%; height: 120px;">${data.access_token}</textarea>
          <p><strong>Scope autorizzati:</strong> ${data.scope}</p>
          <p>Dopo averlo salvato su Render, fai un nuovo deploy e testa la creazione pagina.</p>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Errore callback OAuth",
      details: error.message
    });
  }
});

async function shopifyGraphql(query, variables = {}) {
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN mancante su Render.");
  }

  const shop = cleanShop(SHOPIFY_STORE_DOMAIN);

  const response = await fetch(
    `https://${shop}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN
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

app.get("/admin/test-shopify-token", requireAdminSecret, async (req, res) => {
  try {
    const query = `
      query {
        shop {
          name
          myshopifyDomain
        }
      }
    `;

    const data = await shopifyGraphql(query);

    res.json({
      status: "ok",
      message: "Token Shopify funzionante",
      shop: data.data.shop
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Errore nel test token Shopify",
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
