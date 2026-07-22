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

// API to prefill book details by ISBN or Title with multi-source catalog lookup & anti-hallucination controls
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

    // DIRETRIZ 4: QUEBRA DE LOOP E ANTI-ALUCINAÇÃO
    // Reinicia o objeto de dados totalmente limpo e isolado no escopo desta requisição, sem usar qualquer estado global ou histórico.
    const officialData = {
      isIsbn,
      isbn: isIsbn ? cleanedQuery : "",
      nationalTitle: "",      // Título oficial retornado pela Base Nacional (CBL)
      nationalAuthor: "",     // Autor oficial retornado pela Base Nacional (CBL)
      title: "",              // Título final consolidado
      author: "",             // Autor final consolidado
      publisher: "",          // Editora
      year: "",               // Ano de publicação
      pages: 0,               // Número de páginas
      synopsis: "",           // Sinopse
      foundInCbl: false,      // Indicador se foi localizado na base nacional
      foundInApi: false,      // Indicador se foi localizado em qualquer catálogo
      sources: [] as string[],
      searchResults: [] as any[]
    };

    if (isIsbn) {
      console.log(`[ISBN ${cleanedQuery}] Iniciando consulta isolada. 1) PRIORIDADE DA BASE NACIONAL (CBL)...`);

      // 1. PRIORIDADE DA BASE NACIONAL (CBL via BrasilAPI):
      // Título e Autor da consulta inicial da base nacional são a Autoridade Máxima e devem ser preservados exatamente.
      try {
        const bRes = await fetch(`https://brasilapi.com.br/api/isbn/v1/${cleanedQuery}`, {
          headers: { "Cache-Control": "no-cache" }
        });
        if (bRes.ok) {
          const d = await bRes.json();
          if (d.title) {
            officialData.nationalTitle = d.title.trim();
            officialData.title = d.title.trim();
          }
          if (d.authors) {
            const parsedAuthors = Array.isArray(d.authors) ? d.authors.join(", ").trim() : String(d.authors).trim();
            if (parsedAuthors) {
              officialData.nationalAuthor = parsedAuthors;
              officialData.author = parsedAuthors;
            }
          }
          if (d.publisher) officialData.publisher = String(d.publisher).trim();
          if (d.year) officialData.year = String(d.year).trim();
          if (d.page_count) officialData.pages = Number(d.page_count) || 0;
          if (d.synopsis) officialData.synopsis = String(d.synopsis).trim();

          officialData.foundInCbl = true;
          officialData.foundInApi = true;
          officialData.sources.push("Base Nacional (CBL/BrasilAPI)");
          console.log(`[CBL] Sucesso. Título Nacional PREVALECE: "${officialData.title}" | Autor Nacional: "${officialData.author}"`);
        } else {
          console.log(`[CBL] ISBN ${cleanedQuery} não retornado pela BrasilAPI (status ${bRes.status}).`);
        }
      } catch (err) {
        console.error("Falha ao consultar Base Nacional (BrasilAPI/CBL):", err);
      }

      // 2. REGRA DE COMPLEMENTAÇÃO & 3. PROIBIÇÃO DE SUBSTITUIÇÃO:
      // Repositórios globais (OpenLibrary) são consultados ESTRITAMENTE para preencher campos AUSENTES no retorno nacional.
      // É TERMINANTEMENTE PROIBIDO alterar, traduzir ou substituir o título e o autor definidos pela base nacional.
      const needsComplement = !officialData.synopsis || !officialData.publisher || !officialData.year || !officialData.pages || !officialData.title || !officialData.author;

      if (needsComplement) {
        console.log(`[ISBN ${cleanedQuery}] Buscando complementação em repositórios globais para campos ausentes...`);
        try {
          const olRes = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanedQuery}&format=json&jscmd=data`, {
            headers: { "Cache-Control": "no-cache" }
          });
          if (olRes.ok) {
            const d = await olRes.json();
            const item = d[`ISBN:${cleanedQuery}`];
            if (item) {
              officialData.foundInApi = true;
              if (!officialData.sources.includes("OpenLibrary")) officialData.sources.push("OpenLibrary");

              // PROIBIÇÃO DE SUBSTITUIÇÃO: Apenas preenche título e autor se estiverem estritamente AUSENTES na base nacional
              if (!officialData.title && item.title) {
                officialData.title = String(item.title).trim();
              }
              if (!officialData.author && item.authors) {
                officialData.author = item.authors.map((a: any) => a.name).join(", ").trim();
              }
              // COMPLEMENTAÇÃO DE CAMPOS SECUNDÁRIOS:
              if (!officialData.publisher && item.publishers) {
                officialData.publisher = item.publishers.map((p: any) => p.name).join(", ").trim();
              }
              if (!officialData.year && item.publish_date) {
                officialData.year = String(item.publish_date).trim();
              }
              if (!officialData.pages && item.number_of_pages) {
                officialData.pages = Number(item.number_of_pages) || 0;
              }
              if (!officialData.synopsis && typeof item.notes === "string" && item.notes.trim()) {
                officialData.synopsis = item.notes.trim();
              }
            }
          }
        } catch (err) {
          console.error("Falha ao consultar OpenLibrary para complementação:", err);
        }
      }

      // Complementação Secundária via OpenLibrary Search API (somente se ainda faltar autor ou título)
      if (!officialData.title || !officialData.author) {
        try {
          const olsRes = await fetch(`https://openlibrary.org/search.json?q=${cleanedQuery}&limit=1`);
          if (olsRes.ok) {
            const d = await olsRes.json();
            if (d.docs && d.docs.length > 0) {
              const doc = d.docs[0];
              officialData.foundInApi = true;
              if (!officialData.sources.includes("OpenLibrarySearch")) officialData.sources.push("OpenLibrarySearch");

              if (!officialData.title && doc.title) officialData.title = String(doc.title).trim();
              if (!officialData.author && doc.author_name) officialData.author = doc.author_name.join(", ").trim();
              if (!officialData.year && doc.first_publish_year) officialData.year = String(doc.first_publish_year);
            }
          }
        } catch (err) {
          console.error("Falha ao consultar OpenLibrary Search:", err);
        }
      }
    } else {
      // Busca textual por título/autor
      try {
        const olsRes = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(searchQuery.trim())}&limit=3`);
        if (olsRes.ok) {
          const d = await olsRes.json();
          if (d.docs && d.docs.length > 0) {
            officialData.foundInApi = true;
            officialData.searchResults = d.docs.map((doc: any) => ({
              title: doc.title,
              author: doc.author_name ? doc.author_name.join(", ") : "Desconhecido",
              year: doc.first_publish_year ? String(doc.first_publish_year) : ""
            }));
          }
        }
      } catch (err) {
        console.error("Falha ao buscar títulos na OpenLibrary:", err);
      }
    }

    if (isIsbn && officialData.foundInApi && (officialData.title || officialData.author)) {
      console.log(`[ISBN ${cleanedQuery}] Retornando metadados consolidados. Título final: "${officialData.title}", Autor final: "${officialData.author}"`);

      const bookTitle = officialData.title || `Livro ISBN ${cleanedQuery}`;
      const bookAuthor = officialData.author || "Autor a confirmar";
      const bookPublisher = officialData.publisher || "";
      const bookYear = officialData.year ? String(officialData.year) : "";

      let finalSynopsis = officialData.synopsis;
      if (!finalSynopsis || finalSynopsis.length < 15) {
        finalSynopsis = `Obra "${bookTitle}"${bookAuthor ? ` de ${bookAuthor}` : ''}, cadastrada no catálogo sob o ISBN ${cleanedQuery}.`;
      }

      const editionInfoParts = [bookPublisher, bookYear].filter(Boolean);
      const editionInfo = editionInfoParts.length > 0 ? editionInfoParts.join(", ") : "Edição Registrada";

      return res.json({
        books: [
          {
            title: bookTitle,
            author: bookAuthor,
            genre: "Literatura",
            pages: officialData.pages || 0,
            synopsis: finalSynopsis,
            status: "Quero Ler",
            isbn: cleanedQuery,
            editionInfo: editionInfo,
            publisher: bookPublisher,
            publishYear: bookYear,
            edition: "Edição Brasileira",
            inBoxSet: false,
            boxSetName: "",
            boxSetVolume: ""
          }
        ]
      });
    } else if (isIsbn && !officialData.foundInApi) {
      console.log(`ISBN ${cleanedQuery} não encontrado nos catálogos oficiais. Retornando objeto informativo de não localizado.`);
      return res.json({
        books: [
          {
            title: `[ISBN ${cleanedQuery} - Não localizado no catálogo]`,
            author: "Não localizado",
            genre: "Geral",
            pages: 0,
            synopsis: `Este código de ISBN (${cleanedQuery}) não foi localizado no catálogo oficial. Você pode pesquisar pelo Título do livro na barra de busca para encontrar as edições disponíveis.`,
            status: "Quero Ler",
            isbn: cleanedQuery,
            editionInfo: "",
            publisher: "",
            publishYear: "",
            edition: "",
            inBoxSet: false,
            boxSetName: "",
            boxSetVolume: ""
          }
        ]
      });
    } else {
      const promptText = `Você é um bibliotecário e assistente literário profissional de alta precisão para a "Estante da Lu".
O usuário inseriu a seguinte consulta para encontrar um livro ou coleção (por Título ou Autor): "${searchQuery.trim()}".

REGRAS CRÍTICAS DE VERACIDADE (PREVENÇÃO TOTAL DE ALUCINAÇÕES):
1. Identifique com precisão cirúrgica a obra literária real correspondente à busca do usuário em português brasileiro.
2. Se a busca for sobre um Box Set ou Coleção famosa (ex: "Box Harry Potter"), forneça os livros da coleção com "inBoxSet": true e o nome do box.
3. Se for um livro individual normal, forneça de 1 a 3 edições/versões reais correspondentes ao livro pesquisado.
4. Você está TERMINANTEMENTE PROIBIDO de inventar ou alterar autores/livros reais.

Retorne obrigatoriamente um objeto JSON com a chave "books":
{
  "books": [
    {
      "title": "Título oficial e correto do livro em português brasileiro",
      "author": "Nome do autor principal",
      "genre": "Gênero literário",
      "pages": 250,
      "synopsis": "Uma sinopse cativante e real sem spoilers",
      "status": "Quero Ler",
      "isbn": "",
      "editionInfo": "Rótulo curto da edição (ex: 'Editora Intrínseca')",
      "publisher": "Nome da editora",
      "publishYear": "Ano de publicação",
      "edition": "Edição",
      "inBoxSet": false,
      "boxSetName": "",
      "boxSetVolume": ""
    }
  ]
}`;

      const contents = [{ parts: [{ text: promptText }] }];
      const response = await generateContentWithFetch("gemini-3.5-flash", contents, {
        responseMimeType: "application/json"
      });

      const textOutput = response.text;
      if (!textOutput) {
        throw new Error("O assistente não retornou nenhuma edição do livro.");
      }

      const result = JSON.parse(textOutput.trim());
      const books = result.books || [];

      return res.json({ books });
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
