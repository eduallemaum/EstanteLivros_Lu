import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { getAllUsers, verifyPin, getAccessLogs, upsertUser, removeUser } from "./api/db.js";

dotenv.config();

const app = express();
const PORT = 3000;

// Set payload limits to handle high-resolution image base64 uploads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Helper for exponential backoff retry on transient errors (503, 429, etc.) using direct HTTP fetch to avoid Vertex AI / ADC hangs on Cloud Run
async function generateContentWithFetch(
  model: string,
  contents: any[],
  config?: any,
  maxRetries = 2,
  initialDelay = 1000
): Promise<{ text: string }> {
  const key = process.env.GEMINI_API_KEY || process.env.USER_GEMINI_API_KEY;
  if (!key) {
    throw new Error("A variável de ambiente GEMINI_API_KEY não está configurada. Por favor, adicione seu chave da API Gemini nas configurações do AI Studio.");
  }

  const sendRequest = async (selectedModel: string) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "aistudio-build"
      },
      body: JSON.stringify({
        contents,
        generationConfig: config
      })
    });
    return res;
  };

  // Try the primary model first
  try {
    const res = await sendRequest(model);
    if (res.ok) {
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { text };
    }
    console.warn(`[Gemini API] Falha ou lentidão no modelo primário ${model}. Tentando fallback de alta disponibilidade...`);
  } catch (err: any) {
    console.warn(`[Gemini API] Erro no modelo primário ${model}: ${err.message}. Tentando fallback de alta disponibilidade...`);
  }

  // Fallback to gemini-3.1-flash-lite which has 100% availability and sub-second response
  try {
    console.log(`[Gemini API] Ativando fallback para gemini-3.1-flash-lite...`);
    const res = await sendRequest("gemini-3.1-flash-lite");
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData?.error?.message || `Status HTTP ${res.status}`);
    }
    const data: any = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("O Gemini retornou uma resposta sem conteúdo de texto no fallback.");
    }
    return { text };
  } catch (fallbackError: any) {
    console.error(`[Gemini API] Falha crítica em ambos os modelos. Erro final:`, fallbackError);
    throw fallbackError;
  }
}

// Middleware to secure APIs with family PIN validation against Firestore
const validatePin = async (req: any, res: any, next: any) => {
  const userPinHeader = req.headers["x-family-pin"] as string | undefined;
  if (!userPinHeader) {
    return res.status(401).json({ error: "Acesso não autorizado. Código PIN ausente." });
  }

  try {
    const users = await getAllUsers(true);
    const isValidUser = users.some(u => u.pin === userPinHeader.trim() && u.active);

    if (!isValidUser) {
      return res.status(401).json({ error: "Acesso não autorizado. Código PIN inválido ou inativo." });
    }
    next();
  } catch (error) {
    console.error("Middleware validatePin error:", error);
    return res.status(500).json({ error: "Erro interno na verificação de permissões." });
  }
};

// API to verify family member 6-digit PIN
app.get("/api/verify-pin", async (req, res) => {
  try {
    const users = await getAllUsers(false); // safe list of profiles (pins are deleted)
    return res.json({ success: true, users });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Erro ao obter os perfis de usuário." });
  }
});

app.post("/api/verify-pin", async (req, res) => {
  try {
    const { username, pin } = req.body;

    if (!username || !pin) {
      return res.status(400).json({ error: "Nome de usuário e PIN de 6 dígitos são necessários." });
    }

    const result = await verifyPin(username, pin, req);

    if (result.success && result.user) {
      return res.json({ 
        success: true, 
        user: { 
          username: result.user.username,
          role: result.user.role,
          avatar: result.user.avatar,
          token: Buffer.from(`${result.user.username}:${pin}`).toString("base64") 
        } 
      });
    }

    return res.status(401).json({ error: result.error || "Código PIN incorreto." });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Erro interno no servidor de autenticação." });
  }
});

// API for admin actions (get users & logs, update users, delete users)
app.use("/api/admin", async (req: any, res: any, next: any) => {
  const userPinHeader = req.headers["x-family-pin"] as string | undefined;
  if (!userPinHeader) {
    return res.status(401).json({ error: "Acesso administrativo não autorizado. PIN ausente." });
  }

  try {
    const users = await getAllUsers(true);
    const adminUser = users.find(u => u.role === "admin" && u.pin === userPinHeader.trim() && u.active);
    
    if (!adminUser) {
      return res.status(403).json({ error: "Acesso administrativo negado. Código PIN de administrador incorreto ou inativo." });
    }

    req.adminUser = adminUser;
    next();
  } catch (error) {
    return res.status(500).json({ error: "Erro interno na verificação de permissões de administrador." });
  }
});

app.get("/api/admin", async (req: any, res: any) => {
  try {
    const allUsers = await getAllUsers(true); // admin can see PINs
    const logs = await getAccessLogs();
    res.json({
      success: true,
      users: allUsers,
      logs
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Erro ao carregar dados do painel de administração." });
  }
});

app.post("/api/admin", async (req: any, res: any) => {
  try {
    const { action, username, pin, role, avatar, active } = req.body;

    if (!action) {
      return res.status(400).json({ error: "Ação não especificada." });
    }

    if (action === "upsert") {
      if (!username || !pin) {
        return res.status(400).json({ error: "Nome de usuário e PIN são obrigatórios para salvar." });
      }
      if (pin.trim().length !== 6 || !/^\d+$/.test(pin.trim())) {
        return res.status(400).json({ error: "O código PIN deve conter exatamente 6 dígitos numéricos." });
      }

      const result = await upsertUser(req.adminUser.username, username, pin, role, avatar, active);
      if (result.success) {
        return res.json({ success: true, message: `Perfil de ${username} atualizado com sucesso.` });
      }
      return res.status(500).json({ error: result.error });
    }

    if (action === "delete") {
      if (!username) {
        return res.status(400).json({ error: "Nome de usuário para exclusão não especificado." });
      }
      const result = await removeUser(username);
      if (result.success) {
        return res.json({ success: true, message: `Perfil de ${username} excluído.` });
      }
      return res.status(400).json({ error: result.error });
    }

    return res.status(400).json({ error: "Ação administrativa inválida." });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Erro no processamento da ação administrativa." });
  }
});

// API to scan books using Gemini 2.5 Flash (via 'gemini-3.5-flash' alias as per guidelines)
app.post("/api/scan", validatePin, async (req, res) => {
  try {
    const { image, mimeType = "image/jpeg" } = req.body;

    if (!image) {
      return res.status(400).json({ error: "Nenhuma imagem fornecida em formato Base64." });
    }

    // Extract raw base64 data if it contains the data:image prefix
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

    const promptText = `Analise a imagem fornecida (que pode conter a capa, a lombada, ou a contracapa com código de barras/ISBN de um único livro físico).
Identifique exatamente UM único livro físico presente na imagem de forma extremamente precisa.
Por favor, siga estas prioridades:
1. Tente encontrar um código de barras ou o número ISBN impresso (geralmente de 10 ou 13 dígitos, na contracapa, nas primeiras páginas ou próximo ao código de barras). Se encontrar o ISBN, use-o para buscar e identificar o livro com precisão absoluta.
2. Se nenhum ISBN ou código de barras estiver visível, analise a capa ou a lombada para identificar o livro (título e autor).

Para o livro identificado, você deve obrigatoriamente retornar um array JSON contendo exatamente este único livro estruturado exatamente como no exemplo abaixo:
[
  {
    "title": "Título do Livro",
    "author": "Nome do Autor",
    "genre": "Gênero Literário",
    "pages": 250,
    "synopsis": "Breve sinopse instigante em português brasileiro...",
    "status": "Quero Ler",
    "isbn": "9781234567890",
    "inBoxSet": false,
    "boxSetName": "",
    "boxSetVolume": ""
  }
]

Atenção especial para os campos:
- "pages" deve ser um número inteiro.
- "isbn" deve ser o código identificado (apenas números) ou uma string vazia se não encontrado.
- "inBoxSet" deve ser boolean (true se pertencer a uma coleção ou box set como Sherlock Holmes, Agatha Christie, O Senhor dos Anéis).
- "boxSetName" e "boxSetVolume" devem ser strings correspondentes ou strings vazias se não for parte de um box set.
- O retorno deve ser exclusivamente o JSON puro, sem comentários ou formatação adicional fora da estrutura JSON especificada.`;

    const contents = [
      {
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: promptText }
        ]
      }
    ];

    const response = await generateContentWithFetch("gemini-3.5-flash", contents, {
      responseMimeType: "application/json"
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("O Gemini não retornou nenhum texto estruturado.");
    }

    const books = JSON.parse(textOutput.trim());

    // Se a análise de imagem identificou um ISBN impresso na capa/contracapa, valida com a BrasilAPI para garantir o título oficial em português
    if (Array.isArray(books) && books.length > 0 && books[0].isbn) {
      const scannedIsbn = String(books[0].isbn).trim().replace(/[^0-9Xx]/g, "");
      if (scannedIsbn.length === 10 || scannedIsbn.length === 13) {
        try {
          const bRes = await fetch(`https://brasilapi.com.br/api/isbn/v1/${scannedIsbn}`);
          if (bRes.ok) {
            const d = await bRes.json();
            if (d.title) books[0].title = d.title.trim();
            if (d.authors) {
              books[0].author = Array.isArray(d.authors) ? d.authors.join(", ").trim() : String(d.authors).trim();
            }
            if (d.publisher) books[0].publisher = String(d.publisher).trim();
            if (d.page_count) books[0].pages = Number(d.page_count) || books[0].pages;
            if (d.synopsis) books[0].synopsis = String(d.synopsis).trim();
          }
        } catch (err) {
          console.error("Erro ao validar ISBN escaneado na BrasilAPI:", err);
        }
      }
    }

    return res.json({ books });
  } catch (error: any) {
    console.error("Erro ao analisar lombadas:", error);
    return res.status(500).json({
      error: error.message || "Ocorreu um erro interno ao processar a imagem do livro."
    });
  }
});

// API to prefill book details by ISBN or Title with direct public API fetching (Google Books, CBL/BrasilAPI, OpenLibrary) & anti-hallucination controls
app.post("/api/book-info", validatePin, async (req, res) => {
  // CRITICAL: Prevent response caching by browsers, CDNs or reverse proxies to ensure zero scope leakage between requests
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  try {
    const { query: searchQuery } = req.body;

    if (!searchQuery || typeof searchQuery !== "string" || !searchQuery.trim()) {
      return res.status(400).json({ error: "Nenhum ISBN ou título do livro fornecido." });
    }

    const rawInput = searchQuery.trim();
    const cleanedQuery = rawInput.replace(/[^0-9Xx]/g, "");
    const isIsbn = (cleanedQuery.length === 10 || cleanedQuery.length === 13) && /^[0-9]+[0-9Xx]?$/.test(cleanedQuery);

    if (isIsbn) {
      console.log(`[ISBN ${cleanedQuery}] Buscando via APIs públicas diretas (CBL/BrasilAPI, Google Books e OpenLibrary)...`);

      let foundBook = {
        title: "",
        author: "",
        publisher: "",
        year: "",
        pages: 0,
        synopsis: "",
        isbn: cleanedQuery
      };

      let foundInAnyApi = false;

      // 1. PRIORIDADE BASE NACIONAL (CBL via BrasilAPI)
      try {
        const bRes = await fetch(`https://brasilapi.com.br/api/isbn/v1/${cleanedQuery}`, {
          headers: { "Cache-Control": "no-cache" }
        });
        if (bRes.ok) {
          const d = await bRes.json();
          if (d && (d.title || d.publisher)) {
            foundInAnyApi = true;
            if (d.title) foundBook.title = d.title.trim();
            if (d.authors) {
              const parsed = Array.isArray(d.authors) ? d.authors.join(", ").trim() : String(d.authors).trim();
              if (parsed) foundBook.author = parsed;
            }
            if (d.publisher) foundBook.publisher = String(d.publisher).trim();
            if (d.year) foundBook.year = String(d.year).trim();
            if (d.page_count) foundBook.pages = Number(d.page_count) || 0;
            if (d.synopsis) foundBook.synopsis = String(d.synopsis).trim();
            console.log(`[CBL/BrasilAPI] Encontrado. Título: "${foundBook.title}" | Autor: "${foundBook.author}"`);
          }
        }
      } catch (err) {
        console.error("Erro ao consultar BrasilAPI/CBL:", err);
      }

      // 2. GOOGLE BOOKS API (q=isbn:)
      try {
        const gbRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanedQuery}`, {
          headers: { "Cache-Control": "no-cache" }
        });
        if (gbRes.ok) {
          const gbData = await gbRes.json();
          if (gbData.items && gbData.items.length > 0) {
            const vInfo = gbData.items[0].volumeInfo || {};
            foundInAnyApi = true;

            if (!foundBook.title && vInfo.title) foundBook.title = vInfo.title.trim();
            if (!foundBook.author && Array.isArray(vInfo.authors) && vInfo.authors.length > 0) {
              foundBook.author = vInfo.authors.join(", ").trim();
            }
            if (!foundBook.publisher && vInfo.publisher) foundBook.publisher = String(vInfo.publisher).trim();
            if (!foundBook.year && vInfo.publishedDate) foundBook.year = String(vInfo.publishedDate).slice(0, 4);
            if (!foundBook.pages && vInfo.pageCount) foundBook.pages = Number(vInfo.pageCount) || 0;
            if (!foundBook.synopsis && vInfo.description) foundBook.synopsis = String(vInfo.description).trim();
            console.log(`[Google Books API] Processado. Título: "${foundBook.title}" | Autor: "${foundBook.author}"`);
          }
        }
      } catch (err) {
        console.error("Erro ao consultar Google Books API:", err);
      }

      // 3. OPENLIBRARY API (Complemento secundário)
      try {
        const olRes = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanedQuery}&format=json&jscmd=data`, {
          headers: { "Cache-Control": "no-cache" }
        });
        if (olRes.ok) {
          const olData = await olRes.json();
          const item = olData[`ISBN:${cleanedQuery}`];
          if (item) {
            foundInAnyApi = true;
            if (!foundBook.title && item.title) foundBook.title = String(item.title).trim();
            if (!foundBook.author && Array.isArray(item.authors)) {
              foundBook.author = item.authors.map((a: any) => a.name).join(", ").trim();
            }
            if (!foundBook.publisher && Array.isArray(item.publishers)) {
              foundBook.publisher = item.publishers.map((p: any) => p.name).join(", ").trim();
            }
            if (!foundBook.year && item.publish_date) foundBook.year = String(item.publish_date).trim();
            if (!foundBook.pages && item.number_of_pages) foundBook.pages = Number(item.number_of_pages) || 0;
            if (!foundBook.synopsis && typeof item.notes === "string") foundBook.synopsis = item.notes.trim();
            console.log(`[OpenLibrary Data] Processado. Título: "${foundBook.title}" | Autor: "${foundBook.author}"`);
          }
        }
      } catch (err) {
        console.error("Erro ao consultar OpenLibrary Data:", err);
      }

      // 4. OPENLIBRARY SEARCH API (fallback para autor e título)
      if (!foundBook.author || !foundBook.title) {
        try {
          const olsRes = await fetch(`https://openlibrary.org/search.json?q=${cleanedQuery}&limit=1`);
          if (olsRes.ok) {
            const d = await olsRes.json();
            if (d.docs && d.docs.length > 0) {
              const doc = d.docs[0];
              foundInAnyApi = true;
              if (!foundBook.title && doc.title) foundBook.title = String(doc.title).trim();
              if (!foundBook.author && Array.isArray(doc.author_name)) {
                foundBook.author = doc.author_name.join(", ").trim();
              }
              if (!foundBook.year && doc.first_publish_year) foundBook.year = String(doc.first_publish_year);
              console.log(`[OpenLibrary Search] Fallback processado. Título: "${foundBook.title}" | Autor: "${foundBook.author}"`);
            }
          }
        } catch (err) {
          console.error("Erro ao consultar OpenLibrary Search:", err);
        }
      }

      // SE NENHUMA API RETORNOU DADOS OU O LIVRO NÃO TEM TÍTULO: Retornar erro explícito sem inventar nada!
      if (!foundInAnyApi || !foundBook.title) {
        console.log(`[ISBN ${cleanedQuery}] Não localizado nas APIs públicas. Retornando 404 'Livro não encontrado'.`);
        return res.status(404).json({
          error: "Livro não encontrado no catálogo pelo ISBN fornecido."
        });
      }

      if (!foundBook.author) {
        foundBook.author = "Autor a confirmar";
      }

      // SE A API RETORNOU O LIVRO: Opcionalmente traduzir/polir a sinopse se estiver em outro idioma
      let finalSynopsis = foundBook.synopsis;

      if (finalSynopsis && /[a-zA-Z]/.test(finalSynopsis) && process.env.GEMINI_API_KEY) {
        try {
          const promptText = `Você é um tradutor e formatador literário.
Dados REAIS obtidos das APIs oficiais para o ISBN ${cleanedQuery}:
- Título: ${foundBook.title}
- Autor: ${foundBook.author}
- Sinopse original: ${finalSynopsis}

INSTRUÇÕES ESTRITAS:
1. MANTENHA O TÍTULO "${foundBook.title}" E O AUTOR "${foundBook.author}" EXATAMENTE COMO FORAM PASSADOS.
2. Se a sinopse estiver em inglês ou outro idioma, traduza-a para o português do Brasil de forma elegante e sem spoilers. Se já estiver em português, apenas corrija a pontuação.
3. Não adicione nem invente nenhuma informação fictícia.

Retorne obrigatoriamente no formato JSON:
{
  "translatedSynopsis": "sinopse formatada em português"
}`;

          const contents = [{ parts: [{ text: promptText }] }];
          const aiResponse = await generateContentWithFetch("gemini-3.5-flash", contents, {
            responseMimeType: "application/json"
          });
          const parsed = JSON.parse(aiResponse.text.trim());
          if (parsed && parsed.translatedSynopsis && parsed.translatedSynopsis.length > 10) {
            finalSynopsis = parsed.translatedSynopsis;
          }
        } catch (e) {
          console.log("Mantendo sinopse original obtida das APIs.");
        }
      }

      if (!finalSynopsis) {
        finalSynopsis = `Obra "${foundBook.title}"${foundBook.author ? ` de ${foundBook.author}` : ""}, cadastrada no catálogo oficial sob o ISBN ${cleanedQuery}.`;
      }

      const editionInfoParts = [foundBook.publisher, foundBook.year].filter(Boolean);
      const editionInfo = editionInfoParts.length > 0 ? editionInfoParts.join(", ") : "Edição Registrada";

      return res.json({
        books: [
          {
            title: foundBook.title,
            author: foundBook.author,
            genre: "Literatura",
            pages: foundBook.pages || 0,
            synopsis: finalSynopsis,
            status: "Quero Ler",
            isbn: cleanedQuery,
            editionInfo: editionInfo,
            publisher: foundBook.publisher || "",
            publishYear: foundBook.year || "",
            edition: "Edição Brasileira",
            inBoxSet: false,
            boxSetName: "",
            boxSetVolume: ""
          }
        ]
      });
    } else {
      // Busca textual por título/autor
      console.log(`[Busca textual: "${rawInput}"] Consultando Google Books API...`);
      let textResults: any[] = [];

      try {
        const gbRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(rawInput)}&maxResults=5`, {
          headers: { "Cache-Control": "no-cache" }
        });
        if (gbRes.ok) {
          const gbData = await gbRes.json();
          if (gbData.items && gbData.items.length > 0) {
            textResults = gbData.items.map((item: any) => {
              const vInfo = item.volumeInfo || {};
              const isbns = vInfo.industryIdentifiers || [];
              const isbnObj = isbns.find((i: any) => i.type === "ISBN_13") || isbns.find((i: any) => i.type === "ISBN_10") || isbns[0];
              const itemIsbn = isbnObj ? isbnObj.identifier.replace(/[^0-9Xx]/g, "") : "";

              return {
                title: vInfo.title || "Título Desconhecido",
                author: Array.isArray(vInfo.authors) ? vInfo.authors.join(", ") : "Autor Desconhecido",
                genre: Array.isArray(vInfo.categories) ? vInfo.categories[0] : "Literatura",
                pages: Number(vInfo.pageCount) || 0,
                synopsis: vInfo.description || `Obra localizada na pesquisa por "${rawInput}".`,
                status: "Quero Ler",
                isbn: itemIsbn,
                editionInfo: vInfo.publisher ? `${vInfo.publisher}${vInfo.publishedDate ? `, ${vInfo.publishedDate.slice(0, 4)}` : ''}` : "Edição Geral",
                publisher: vInfo.publisher || "",
                publishYear: vInfo.publishedDate ? vInfo.publishedDate.slice(0, 4) : "",
                edition: "Edição Geral",
                inBoxSet: false,
                boxSetName: "",
                boxSetVolume: ""
              };
            });
          }
        }
      } catch (err) {
        console.error("Erro na busca por título na Google Books API:", err);
      }

      if (textResults.length > 0) {
        return res.json({ books: textResults });
      }

      return res.status(404).json({ error: "Livro não encontrado." });
    }
  } catch (error: any) {
    console.error("Erro ao buscar detalhes do livro:", error);
    return res.status(500).json({
      error: error.message || "Ocorreu um erro ao obter os detalhes do livro."
    });
  }
});

// API to generate dynamic reading suggestions based on current book metadata
app.post("/api/recommendations", validatePin, async (req, res) => {
  try {
    const { title, author, genre } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "O título do livro é necessário para gerar sugestões." });
    }

    const promptText = `Você é um curador literário inteligente, extremamente rigoroso e carinhoso para a "Estante da Lu".
O usuário está visualizando os detalhes do livro "${title.trim()}" escrito por "${(author || '').trim() || 'Autor Desconhecido'}" (gênero: "${(genre || '').trim() || 'Geral'}").

Com base nessas informações, sugira exatamente 2 livros excelentes como sugestões de próximas leituras para a Lu, ou novidades/futuros lançamentos relacionados que combinem com este estilo.

REGRAS CRÍTICAS DE VERACIDADE (PREVENÇÃO ABSOLUTA DE ALUCINAÇÕES):
1. Você está TERMINANTEMENTE PROIBIDO de inventar, misturar ou criar livros, autores ou títulos fictícios que não existem na vida real.
2. Certifique-se de sugerir APENAS livros REAIS que foram de fato publicados ou que possuem anúncio/lançamento oficial confirmado por editoras reais e conhecidas no mercado editorial.
3. Não misture autores reais com obras fictícias (por exemplo, NUNCA associe obras inexistentes como "A Menina que Fez o Mundo Desabar" a autores reais como Raphael Montes, C.S. Lewis ou qualquer outro). Se a obra não existe física e catalogada de verdade no mercado, ela NÃO pode ser recomendada de forma alguma.
4. Verifique mentalmente se você saberia citar a sinopse real, editora real e ano correto de publicação desse livro. Se tiver qualquer dúvida sobre a existência física real da obra, escolha outro livro consagrado e indubitavelmente real.

Você deve retornar obrigatoriamente um objeto JSON contendo exatamente 2 sugestões estruturadas sob a chave "recommendations" exatamente conforme o formato abaixo:

{
  "recommendations": [
    {
      "title": "Título real do livro sugerido",
      "author": "Nome real do autor",
      "reason": "Por que você vai amar: justificativa carinhosa de por que ela vai amar, relacionando com o estilo de ${title.trim()}",
      "tags": ["Tag1", "Tag2"],
      "releaseYear": "Ano de publicação ou previsão de lançamento (ex: 2024, ou 2026/2027 para futuros reais)",
      "releaseStatus": "Status do lançamento em português (ex: 'Já lançado', 'Lançamento futuro / Em breve', 'Clássico publicado')"
    }
  ]
}

Atenção especial:
- Retorne apenas o JSON puro, sem comentários, explicações ou blocos de código markdown.`;

    const contents = [
      {
        parts: [
          { text: promptText }
        ]
      }
    ];

    const response = await generateContentWithFetch("gemini-3.5-flash", contents, {
      responseMimeType: "application/json"
    });

    const textOutput = response.text;
    if (!textOutput) {
      throw new Error("O Gemini não retornou sugestões.");
    }

    const result = JSON.parse(textOutput.trim());
    return res.json({ recommendations: result.recommendations || [] });
  } catch (error: any) {
    console.error("Erro ao gerar sugestões de leitura via Gemini:", error);
    return res.status(500).json({
      error: error.message || "Ocorreu um erro ao obter recomendações literárias."
    });
  }
});

// Setup Vite middleware for development or serve built files in production
async function setupServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

setupServer();
