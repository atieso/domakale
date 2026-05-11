import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import pg from "pg";
import OpenAI from "openai";

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
  MIN_CONTENT_LENGTH,
  OPENAI_API_KEY,
  OPENAI_MODEL
} = process.env;

const APP_URL = "https://domakale.onrender.com";

const DEFAULT_INTERNAL_URL = "/collections/all";

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

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
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

function titleFromKeyword(keyword) {
  return String(keyword || "")
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 2) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
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
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(",") : rest[key];
      return `${key}=${value}`;
    })
    .join("&");

  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(generatedHash, "utf8"),
      Buffer.from(hmac, "utf8")
    );
  } catch {
    return false;
  }
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

async function generateSeoPageWithOpenAI(keywordRow) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY mancante su Render.");
  }

  const keyword = keywordRow.keyword;
  const titoloPagina = keywordRow.titolo_pagina || titleFromKeyword(keyword);
  const urlTarget = keywordRow.url_target || DEFAULT_INTERNAL_URL;

  const minLength = Number(MIN_CONTENT_LENGTH || 3000);
  const targetLength = Math.max(minLength + 600, 3600);

  const prompt = `
Genera una pagina SEO-oriented per Shopify basata sulla keyword: "${keyword}".

Dati disponibili:
- Titolo pagina suggerito: "${titoloPagina}"
- Link interno target: "${urlTarget}"

Requisiti:
- Lingua: italiano
- Lunghezza minima obbligatoria del solo contenuto HTML: ${targetLength} caratteri
- Non fermarti appena superi i 3.000 caratteri: genera un testo completo, approfondito e utile
- Tono: professionale, commerciale, utile per l’utente
- Struttura in HTML pulito
- Inserisci un solo H1
- Inserisci almeno 2 H2
- Inserisci almeno un elenco puntato
- Inserisci una sezione FAQ con almeno 3 domande e risposte
- Inserisci naturalmente la keyword principale
- Inserisci varianti semantiche della keyword
- Inserisci una call to action finale
- Inserisci almeno un link interno verso: "${urlTarget}"
- Non generare contenuto generico o duplicato
- Non promettere prezzi, disponibilità, certificazioni, tempi di consegna o servizi non confermati
- Non citare il fatto che il testo è stato generato automaticamente
- Non usare frasi vuote come “nel mondo di oggi” o “in un mercato sempre più competitivo”

Output richiesto esclusivamente in JSON valido:

{
  "title": "",
  "handle": "",
  "meta_title": "",
  "meta_description": "",
  "html_body": ""
}
`;

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL || "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "Sei un SEO copywriter esperto per ecommerce Shopify. Generi solo JSON valido, senza markdown e senza testo extra."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0.7,
    max_tokens: 3500,
    response_format: {
      type: "json_object"
    }
  });

  const raw = response.choices?.[0]?.message?.content;

  if (!raw) {
    throw new Error("OpenAI non ha restituito contenuto.");
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`JSON OpenAI non valido: ${raw.slice(0, 500)}`);
  }

  if (
    !parsed.title ||
    !parsed.handle ||
    !parsed.meta_title ||
    !parsed.meta_description ||
    !parsed.html_body
  ) {
    throw new Error(
      "Output OpenAI incompleto: mancano title, handle, meta_title, meta_description o html_body."
    );
  }

  if (parsed.html_body.length < minLength) {
    throw new Error(
      `OpenAI ha generato un contenuto troppo corto: ${parsed.html_body.length} caratteri. Minimo richiesto: ${minLength}. Riprova la generazione.`
    );
  }

  parsed.handle = slugify(parsed.handle || parsed.title || keyword);

  return parsed;
}

function validateGeneratedPage(generated) {
  const minLength = Number(MIN_CONTENT_LENGTH || 3000);
  const html = generated.html_body || "";

  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  const h2Count = (html.match(/<h2[\s>]/gi) || []).length;
  const linkCount = (html.match(/<a\s+[^>]*href=/gi) || []).length;

  const faqHint =
    html.toLowerCase().includes("domande frequenti") ||
    html.toLowerCase().includes("faq");

  if (html.length < minLength) {
    throw new Error(
      `Contenuto troppo corto: ${html.length} caratteri. Minimo richiesto: ${minLength}.`
    );
  }

  if (!generated.title || generated.title.length < 5) {
    throw new Error("Titolo pagina mancante o troppo corto.");
  }

  if (!generated.handle || generated.handle.length < 5) {
    throw new Error("Handle mancante o troppo corto.");
  }

  if (!generated.meta_title || generated.meta_title.length < 20) {
    throw new Error("Meta title mancante o troppo corto.");
  }

  if (!generated.meta_description || generated.meta_description.length < 50) {
    throw new Error("Meta description mancante o troppo corta.");
  }

  if (h1Count !== 1) {
    throw new Error(
      `Numero H1 non valido: trovati ${h1Count}. Deve essercene uno solo.`
    );
  }

  if (h2Count < 2) {
    throw new Error(
      `H2 insufficienti: trovati ${h2Count}. Minimo richiesto: 2.`
    );
  }

  if (linkCount < 1) {
    throw new Error("Manca almeno un link interno.");
  }

  if (!faqHint) {
    throw new Error("Manca una sezione FAQ/Domande frequenti.");
  }

  return true;
}

async function createShopifyPage({
  title,
  handle,
  body,
  metaTitle = "",
  metaDescription = "",
  isPublished = false
}) {
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

  const pageInput = {
    title,
    handle,
    body,
    isPublished
  };

  if (metaTitle || metaDescription) {
    pageInput.seo = {
      title: metaTitle,
      description: metaDescription
    };
  }

  const variables = {
    page: pageInput
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

    const response = await fetch(
      `https://${cleanShopDomain}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          client_id: SHOPIFY_CLIENT_ID,
          client_secret: SHOPIFY_CLIENT_SECRET,
          code
        })
      }
    );

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
      body:
        "<h1>Pagina test SEO Generator</h1><p>Questa è una pagina di test creata automaticamente dall'app SEO Page Generator.</p>",
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
      LIMIT 300
    `);

    const rows = result.rows;

    res.send(`
      <html>
        <head>
          <title>Keyword SEO Generator</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 40px;">
          <h1>Keyword SEO Generator</h1>

          <h2>Aggiungi una keyword</h2>

          <form method="POST" action="/admin/keywords?secret=${ADMIN_SECRET}">
            <p>
              <label>Keyword</label><br>
              <input name="keyword" style="width: 600px;" required>
            </p>

            <button type="submit">Salva keyword</button>
          </form>

          <hr style="margin: 40px 0;">

          <h2>Incolla elenco keyword</h2>

          <p>Inserisci una keyword per riga. Il sistema salverà ogni riga come keyword separata.</p>

          <form method="POST" action="/admin/keywords/bulk?secret=${ADMIN_SECRET}">
            <p>
              <label>Elenco keyword</label><br>
              <textarea 
                name="keywords_bulk" 
                style="width: 700px; height: 240px;" 
                placeholder="tende per hotel vicenza&#10;tende oscuranti per alberghi&#10;tende ignifughe per hotel"
                required></textarea>
            </p>

            <button type="submit">Salva elenco keyword</button>
          </form>

          <hr style="margin: 40px 0;">

          <h2>Keyword salvate</h2>

          <table border="1" cellpadding="8" cellspacing="0">
            <tr>
              <th>ID</th>
              <th>Keyword</th>
              <th>Stato</th>
              <th>URL Shopify</th>
              <th>Errore</th>
              <th>Azione</th>
            </tr>

            ${rows
              .map(
                (row) => `
              <tr>
                <td>${row.id}</td>
                <td>${escapeHtml(row.keyword)}</td>
                <td>${escapeHtml(row.stato)}</td>
                <td>
                  ${
                    row.shopify_url
                      ? `<a href="${row.shopify_url}" target="_blank">Apri</a>`
                      : "-"
                  }
                </td>
                <td style="max-width: 360px; font-size: 12px;">
                  ${row.errore ? escapeHtml(row.errore) : "-"}
                </td>
                <td>
                  <form method="POST" action="/admin/keywords/${row.id}/generate?secret=${ADMIN_SECRET}">
                    <button type="submit">Genera pagina</button>
                  </form>
                </td>
              </tr>
            `
              )
              .join("")}
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
    const { keyword } = req.body;

    if (!keyword || !keyword.trim()) {
      return res.status(400).send("Keyword mancante.");
    }

    const cleanKeyword = keyword.trim();

    const existing = await pool.query(
      `SELECT id FROM seo_keywords WHERE LOWER(keyword) = LOWER($1) LIMIT 1`,
      [cleanKeyword]
    );

    if (existing.rows.length === 0) {
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
        VALUES ($1, $2, NULL, NULL, $3, 'da_generare')
        `,
        [
          cleanKeyword,
          titleFromKeyword(cleanKeyword),
          DEFAULT_INTERNAL_URL
        ]
      );
    }

    res.redirect(`/admin/keywords?secret=${ADMIN_SECRET}`);
  } catch (error) {
    res
      .status(500)
      .send(`Errore salvataggio keyword: ${escapeHtml(error.message)}`);
  }
});

app.post("/admin/keywords/bulk", requireAdminSecret, async (req, res) => {
  try {
    const { keywords_bulk } = req.body;

    if (!keywords_bulk || !keywords_bulk.trim()) {
      return res.status(400).send("Nessuna keyword inserita.");
    }

    const lines = keywords_bulk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const uniqueKeywords = [...new Set(lines)];

    let inserted = 0;
    let skipped = 0;

    for (const keyword of uniqueKeywords) {
      const existing = await pool.query(
        `SELECT id FROM seo_keywords WHERE LOWER(keyword) = LOWER($1) LIMIT 1`,
        [keyword]
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

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
        VALUES ($1, $2, NULL, NULL, $3, 'da_generare')
        `,
        [
          keyword,
          titleFromKeyword(keyword),
          DEFAULT_INTERNAL_URL
        ]
      );

      inserted++;
    }

    res.send(`
      <html>
        <head>
          <title>Import keyword completato</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 40px;">
          <h1>Import keyword completato</h1>
          <p><strong>Keyword inserite:</strong> ${inserted}</p>
          <p><strong>Keyword duplicate saltate:</strong> ${skipped}</p>

          <p>
            <a href="/admin/keywords?secret=${ADMIN_SECRET}">
              Torna alla gestione keyword
            </a>
          </p>
        </body>
      </html>
    `);
  } catch (error) {
    res
      .status(500)
      .send(`Errore import keyword: ${escapeHtml(error.message)}`);
  }
});

app.post("/admin/keywords/:id/generate", requireAdminSecret, async (req, res) => {
  const id = req.params.id;

  try {
    const result = await pool.query(`SELECT * FROM seo_keywords WHERE id = $1`, [
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).send("Keyword non trovata");
    }

    const keywordRow = result.rows[0];

    await pool.query(
      `
      UPDATE seo_keywords
      SET stato = 'in_generazione',
          errore = null,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [id]
    );

    const generated = await generateSeoPageWithOpenAI(keywordRow);

    validateGeneratedPage(generated);

    const page = await createShopifyPage({
      title: generated.title,
      handle: `${generated.handle}-${Date.now()}`,
      body: generated.html_body,
      metaTitle: generated.meta_title,
      metaDescription: generated.meta_description,
      isPublished: false
    });

    const shopifyUrl = `https://${cleanShop(SHOPIFY_STORE_DOMAIN)}/pages/${
      page.handle
    }`;

    await pool.query(
      `
      UPDATE seo_keywords
      SET
        stato = 'bozza_generata',
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

    res
      .status(500)
      .send(`Errore generazione pagina: ${escapeHtml(error.message)}`);
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
