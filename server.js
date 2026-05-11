import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_ADMIN_ACCESS_TOKEN,
  ADMIN_SECRET,
  DATABASE_URL,
  MIN_CONTENT_LENGTH
} = process.env;

const APP_URL = "https://domakale.onrender.com";

const SCOPES = [
  "read_content",
  "write_content",
  "read_online_store_pages",
  "write_online_store_pages",
  "read_products"
].join(",");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function cleanShop(shop) {
  return String(shop || "")
    .replace("https://", "")
    .replace("http://", "")
    .replace("/", "")
    .trim()
    .toLowerCase();
}

function requireAdminSecret(req, res, next) {
  const secret = req.query.secret || req.body.secret;

  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).send("Accesso non autorizzato");
  }

  next();
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 90);
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seo_keywords (
      id SERIAL PRIMARY KEY,
      keyword TEXT NOT NULL,
      titolo_pagina TEXT,
      categoria TEXT,
      citta TEXT,
      url_target TEXT DEFAULT '/collections/all',
      priorita INTEGER DEFAULT 999,
      stato TEXT DEFAULT 'da_generare',
      shopify_page_id TEXT,
      shopify_url TEXT,
      errore TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

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

function generateTemporarySeoHtml(keyword, urlTarget = "/collections/all") {
  const safeKeyword = escapeHtml(keyword);
  const safeUrl = escapeHtml(urlTarget || "/collections/all");

  return `
    <h1>${safeKeyword}</h1>

    <p>${safeKeyword} è una soluzione pensata per chi desidera trovare informazioni chiare, utili e orientate alla scelta più adatta alle proprie esigenze. Questa pagina nasce per offrire una panoramica completa, con indicazioni pratiche, vantaggi, contesti di utilizzo e suggerimenti per valutare con maggiore consapevolezza le alternative disponibili.</p>

    <h2>Perché scegliere ${safeKeyword}</h2>
    <p>Quando si cerca ${safeKeyword}, è importante valutare non solo l’aspetto estetico o commerciale, ma anche la qualità della proposta, la coerenza con il contesto d’uso e la possibilità di ricevere un servizio realmente adatto alle proprie necessità. Una pagina informativa ben strutturata aiuta l’utente a orientarsi meglio e consente al sito di presentare in modo ordinato prodotti, servizi o soluzioni collegate.</p>

    <h2>Caratteristiche principali</h2>
    <ul>
      <li>Contenuto pensato per rispondere a una ricerca specifica dell’utente.</li>
      <li>Struttura SEO con titolo, sezioni descrittive e collegamenti interni.</li>
      <li>Testo organizzato per migliorare leggibilità e navigazione.</li>
      <li>Possibilità di collegare la pagina a categorie, prodotti o servizi presenti nello store.</li>
    </ul>

    <h2>Quando può essere utile</h2>
    <p>Una pagina dedicata a ${safeKeyword} può essere utile quando si vuole intercettare una ricerca precisa, valorizzare una categoria dello store o creare un percorso informativo che accompagni il visitatore verso una scelta. Questo approccio è particolarmente efficace per keyword long-tail, pagine locali, contenuti informativi e landing SEO collegate a prodotti o collezioni Shopify.</p>

    <p>La creazione di pagine specifiche permette di ampliare la presenza organica del sito, migliorare l’interlinking interno e costruire contenuti più pertinenti rispetto alle intenzioni di ricerca degli utenti. Ogni pagina dovrebbe però mantenere un contenuto unico, utile e realmente differenziato, evitando testi troppo simili o generici.</p>

    <h2>Domande frequenti</h2>

    <h3>Questa pagina è collegata a prodotti o collezioni?</h3>
    <p>Sì, la pagina può essere collegata a una collezione, a una pagina interna o a un prodotto specifico dello store, così da creare un percorso di navigazione coerente.</p>

    <h3>Il contenuto può essere personalizzato?</h3>
    <p>Sì, ogni contenuto può essere generato partendo da keyword, categoria, località, titolo suggerito e link interno target.</p>

    <h3>Perché creare pagine SEO specifiche?</h3>
    <p>Le pagine SEO specifiche aiutano a intercettare ricerche più dettagliate e a presentare contenuti più pertinenti per l’utente, migliorando la qualità complessiva del sito.</p>

    <h2>Scopri le soluzioni disponibili</h2>
    <p>Per approfondire, visita la sezione collegata: <a href="${safeUrl}">scopri di più</a>.</p>
  `;
}

async function createShopifyPage({ title, handle, body, isPublished = false }) {
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
      title,
      handle,
      body,
      isPublished
    }
  };

  const data = await shopifyGraphql(mutation, variables);
  const result = data.data.pageCreate;

  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(JSON.stringify(result.userErrors));
  }

  return result.page;
}

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SEO Page Generator</title>
      </head>
      <body style="font-family: Arial, sans-serif; padding: 40px;">
        <h1>SEO Page Generator attivo</h1>
        <p>L'app è online e collegata a Shopify.</p>

        <p>
          <a href="/admin/keywords?secret=${ADMIN_SECRET}">
            Vai alla gestione keyword
          </a>
        </p>

        <p>
          <a href="/auth?shop=${SHOPIFY_STORE_DOMAIN}">
            Reinstalla/autorizza app Shopify
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
    const page = await createShopifyPage({
      title: "Pagina test SEO Generator",
      handle: `pagina-test-seo-generator-${Date.now()}`,
      body: "<h1>Pagina test SEO Generator</h1><p>Questa è una pagina di test creata automaticamente dall'app SEO Page Generator.</p>",
      isPublished: false
    });

    res.json({
      status: "ok",
      message: "Test creazione pagina eseguito",
      page
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Errore nella creazione pagina Shopify",
      details: error.message
    });
  }
});

app.get("/admin/keywords", requireAdminSecret, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM seo_keywords
      ORDER BY id DESC
      LIMIT 100
    `);

    const rows = result.rows;

    res.send(`
      <html>
        <head>
          <title>Keyword SEO Generator</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 40px;">
          <h1>Keyword SEO Generator</h1>

          <h2>Aggiungi keyword</h2>
          <form method="POST" action="/admin/keywords?secret=${ADMIN_SECRET}">
            <p>
              <label>Keyword</label><br>
              <input name="keyword" style="width: 500px;" required>
            </p>

            <p>
              <label>Titolo pagina</label><br>
              <input name="titolo_pagina" style="width: 500px;">
            </p>

            <p>
              <label>Categoria</label><br>
              <input name="categoria" style="width: 500px;">
            </p>

            <p>
              <label>Città</label><br>
              <input name="citta" style="width: 500px;">
            </p>

            <p>
              <label>URL target interno</label><br>
              <input name="url_target" value="/collections/all" style="width: 500px;">
            </p>

            <button type="submit">Salva keyword</button>
          </form>

          <h2>Keyword salvate</h2>

          <table border="1" cellpadding="8" cellspacing="0">
            <tr>
              <th>ID</th>
              <th>Keyword</th>
              <th>Stato</th>
              <th>URL Shopify</th>
              <th>Azione</th>
            </tr>

            ${rows.map(row => `
              <tr>
                <td>${row.id}</td>
                <td>${escapeHtml(row.keyword)}</td>
                <td>${escapeHtml(row.stato)}</td>
                <td>${row.shopify_url ? `<a href="${row.shopify_url}" target="_blank">Apri</a>` : "-"}</td>
                <td>
                  <form method="POST" action="/admin/keywords/${row.id}/generate?secret=${ADMIN_SECRET}">
                    <button type="submit">Genera pagina</button>
                  </form>
                </td>
              </tr>
            `).join("")}
          </table>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`Errore database: ${escapeHtml(error.message)}`);
  }
});

app.post("/admin/keywords", requireAdminSecret, async (req, res) => {
  try {
    const {
      keyword,
      titolo_pagina,
      categoria,
      citta,
      url_target
    } = req.body;

    await pool.query(
      `
      INSERT INTO seo_keywords (
        keyword,
        titolo_pagina,
        categoria,
        citta,
        url_target,
        stato
      )
      VALUES ($1, $2, $3, $4, $5, 'da_generare')
      `,
      [
        keyword,
        titolo_pagina || null,
        categoria || null,
        citta || null,
        url_target || "/collections/all"
      ]
    );

    res.redirect(`/admin/keywords?secret=${ADMIN_SECRET}`);
  } catch (error) {
    res.status(500).send(`Errore salvataggio keyword: ${escapeHtml(error.message)}`);
  }
});

app.post("/admin/keywords/:id/generate", requireAdminSecret, async (req, res) => {
  const id = req.params.id;

  try {
    const result = await pool.query(
      `SELECT * FROM seo_keywords WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Keyword non trovata");
    }

    const keywordRow = result.rows[0];

    await pool.query(
      `UPDATE seo_keywords SET stato = 'in_generazione', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );

    const title = keywordRow.titolo_pagina || keywordRow.keyword;
    const handle = slugify(title);
    const body = generateTemporarySeoHtml(keywordRow.keyword, keywordRow.url_target);

    const minimumLength = Number(MIN_CONTENT_LENGTH || 3000);

    if (body.length < minimumLength) {
      throw new Error(`Contenuto troppo corto: ${body.length} caratteri. Minimo richiesto: ${minimumLength}.`);
    }

    const page = await createShopifyPage({
      title,
      handle: `${handle}-${Date.now()}`,
      body,
      isPublished: false
    });

    const shopifyUrl = `https://${cleanShop(SHOPIFY_STORE_DOMAIN)}/pages/${page.handle}`;

    await pool.query(
      `
      UPDATE seo_keywords
      SET
        stato = 'pubblicata',
        shopify_page_id = $1,
        shopify_url = $2,
        errore = null,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      `,
      [page.id, shopifyUrl, id]
    );

    res.redirect(`/admin/keywords?secret=${ADMIN_SECRET}`);
  } catch (error) {
    await pool.query(
      `
      UPDATE seo_keywords
      SET
        stato = 'errore',
        errore = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [error.message, id]
    );

    res.status(500).send(`Errore generazione pagina: ${escapeHtml(error.message)}`);
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`App attiva sulla porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Errore inizializzazione database:", error);
    process.exit(1);
  });
