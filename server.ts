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
  try {
    const { query: searchQuery } = req.body;

    if (!searchQuery || !searchQuery.trim()) {
      return res.status(400).json({ error: "Nenhum ISBN ou título do livro fornecido." });
    }

    const cleanedQuery = searchQuery.trim().replace(/[^0-9Xx]/g, "");
    const isIsbn = (cleanedQuery.length === 10 || cleanedQuery.length === 13) && /^[0-9]+[0-9Xx]?$/.test(cleanedQuery);

    let officialData = {
      isIsbn,
      isbn: isIsbn ? cleanedQuery : "",
      title: "",
      author: "",
      publisher: "",
      year: "",
      pages: 0,
      synopsis: "",
      foundInApi: false,
      sources: [] as string[],
      searchResults: [] as any[]
    };

    if (isIsbn) {
      console.log(`Buscando ISBN ${cleanedQuery} em múltiplas bases oficiais...`);

      // 1. Consultar BrasilAPI
      try {
        const bRes = await fetch(`https://brasilapi.com.br/api/isbn/v1/${cleanedQuery}`);
        if (bRes.ok) {
          const d = await bRes.json();
          if (d.title) officialData.title = d.title.trim();
          if (d.authors) {
            officialData.author = Array.isArray(d.authors) ? d.authors.join(", ").trim() : String(d.authors).trim();
          }
          if (d.publisher) officialData.publisher = String(d.publisher).trim();
          if (d.year) officialData.year = String(d.year).trim();
          if (d.page_count) officialData.pages = Number(d.page_count) || 0;
          if (d.synopsis) officialData.synopsis = String(d.synopsis).trim();
          officialData.foundInApi = true;
          officialData.sources.push("BrasilAPI");
        }
      } catch (err) {
        console.error("Falha ao consultar BrasilAPI:", err);
      }

      // 2. Consultar OpenLibrary (complementar ou buscar dados se BrasilAPI não encontrou)
      try {
        const olRes = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanedQuery}&format=json&jscmd=data`);
        if (olRes.ok) {
          const d = await olRes.json();
          const item = d[`ISBN:${cleanedQuery}`];
          if (item) {
            if (!officialData.title && item.title) officialData.title = String(item.title).trim();
            if (!officialData.author && item.authors) {
              officialData.author = item.authors.map((a: any) => a.name).join(", ").trim();
            }
            if (!officialData.publisher && item.publishers) {
              officialData.publisher = item.publishers.map((p: any) => p.name).join(", ").trim();
            }
            if (!officialData.year && item.publish_date) officialData.year = String(item.publish_date).trim();
            if (officialData.pages === 0 && item.number_of_pages) officialData.pages = Number(item.number_of_pages) || 0;
            if (!officialData.synopsis && typeof item.notes === "string") officialData.synopsis = item.notes.trim();
            officialData.foundInApi = true;
            officialData.sources.push("OpenLibrary");
          }
        }
      } catch (err) {
        console.error("Falha ao consultar OpenLibrary:", err);
      }

      // 3. Consultar OpenLibrary Search API para o número do ISBN se ainda faltar autor ou título
      if (!officialData.title || !officialData.author) {
        try {
          const olsRes = await fetch(`https://openlibrary.org/search.json?q=${cleanedQuery}&limit=1`);
          if (olsRes.ok) {
            const d = await olsRes.json();
            if (d.docs && d.docs.length > 0) {
              const doc = d.docs[0];
              if (!officialData.title && doc.title) officialData.title = String(doc.title).trim();
              if (!officialData.author && doc.author_name) officialData.author = doc.author_name.join(", ").trim();
              if (!officialData.year && doc.first_publish_year) officialData.year = String(doc.first_publish_year);
              officialData.foundInApi = true;
              officialData.sources.push("OpenLibrarySearch");
            }
          }
        } catch (err) {
          console.error("Falha ao consultar OpenLibrary Search:", err);
        }
      }
    } else {
      // Busca por título/texto
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

    let promptText = "";

    if (isIsbn && officialData.foundInApi && (officialData.title || officialData.author)) {
      promptText = `Você é um bibliotecário e assistente literário profissional de alta precisão da "Estante da Lu".
O usuário buscou o ISBN "${cleanedQuery}". A consulta às bases oficiais de ISBN (${officialData.sources.join(", ")}) retornou os seguintes dados REAIS e VERIFICADOS da obra:
- Título Oficial: "${officialData.title}"
- Autor(es) Oficiais: "${officialData.author || 'Autor não informado no catálogo'}"
- Editora Oficial: "${officialData.publisher}"
- Ano de Lançamento: "${officialData.year}"
- Número de Páginas: ${officialData.pages}
- Sinopse registrada: "${officialData.synopsis}"

REGRAS OBRIGATÓRIAS E IMUTÁVEIS (PREVENÇÃO ABSOLUTA DE ALUCINAÇÕES):
1. O Título Oficial ("${officialData.title}") e o Autor ("${officialData.author || 'Autor da obra'}") são DADOS REAIS e IMUTÁVEIS. Você está STRICTLY FORBIDDEN de alterar o título ou inventar outro autor/livro.
2. Se a sinopse registrada for curta ou vazia, elabore uma sinopse cativante e envolvente em português brasileiro exclusivamente sobre o livro REAL "${officialData.title}".
3. Estime o gênero literário correto para a obra "${officialData.title}".
4. Se o título ou ISBN indicar um Box Set / Coleção (ex: "Box Harry Potter"), inclua os livros componentes mantendo a fidelidade.

Retorne obrigatoriamente um objeto JSON com a chave "books":
{
  "books": [
    {
      "title": "${(officialData.title || '').replace(/"/g, '\\"')}",
      "author": "${(officialData.author || '').replace(/"/g, '\\"')}",
      "genre": "Gênero estimado",
      "pages": ${officialData.pages || 200},
      "synopsis": "Sua sinopse bem elaborada especificamente sobre este livro real",
      "status": "Quero Ler",
      "isbn": "${cleanedQuery}",
      "editionInfo": "${(officialData.publisher || '').replace(/"/g, '\\"')}${officialData.year ? `, ${officialData.year}` : ''}",
      "publisher": "${(officialData.publisher || '').replace(/"/g, '\\"')}",
      "publishYear": "${officialData.year ? String(officialData.year) : ''}",
      "edition": "Edição Brasileira",
      "inBoxSet": false,
      "boxSetName": "",
      "boxSetVolume": ""
    }
  ]
}`;
    } else if (isIsbn && !officialData.foundInApi) {
      promptText = `Você é um bibliotecário de alta precisão da "Estante da Lu".
O usuário buscou o código numérico de ISBN "${cleanedQuery}".
ATENÇÃO: Nenhuma base oficial de livros (BrasilAPI, OpenLibrary, Google Books) possui registro catalogado para o ISBN ${cleanedQuery}.

REGRAS CRÍTICAS DE SEGURANÇA E VERACIDADE:
1. Você está TERMINANTEMENTE PROIBIDO de inventar ou adivinhar um livro aleatório a partir de um código numérico de ISBN não cadastrado.
2. Apenas se você tiver 100% de CERTEZA ABSOLUTA na sua base interna sobre qual obra exatamente corresponde a este ISBN ${cleanedQuery}, retorne os dados reais.
3. Se você NÃO tiver 100% de certeza do livro correspondente a este ISBN, você DEVE retornar o título como "[ISBN ${cleanedQuery} - Não localizado]" com o autor "Não encontrado" e instruir na sinopse a buscar pelo Título do livro.

Retorne obrigatoriamente um objeto JSON no formato:
{
  "books": [
    {
      "title": "[ISBN ${cleanedQuery} - Não localizado no catálogo]",
      "author": "Não localizado",
      "genre": "Geral",
      "pages": 0,
      "synopsis": "Este número de ISBN não foi localizado nos catálogos oficiais de livros. Por favor, tente pesquisar pelo Título do livro ou pelo nome do Autor no campo de busca.",
      "status": "Quero Ler",
      "isbn": "${cleanedQuery}",
      "editionInfo": "",
      "publisher": "",
      "publishYear": "",
      "edition": "",
      "inBoxSet": false,
      "boxSetName": "",
      "boxSetVolume": ""
    }
  ]
}`;
    } else {
      let catalogContext = "";
      if (officialData.searchResults && officialData.searchResults.length > 0) {
        const list = officialData.searchResults.map((r: any) => `- "${r.title}" por ${r.author} (${r.year || 'ano N/I'})`).join("\n");
        catalogContext = `Resultados reais encontrados nos catálogos mundiais de livros:\n${list}\nUse estes livros REAIS como referência prioritária.`;
      } else {
        catalogContext = `A busca no catálogo mundial de livros retornou 0 registros para a consulta "${searchQuery.trim()}".`;
      }

      promptText = `Você é um bibliotecário e assistente literário profissional de alta precisão para a "Estante da Lu".
O usuário inseriu a seguinte consulta para encontrar um livro ou coleção: "${searchQuery.trim()}".

${catalogContext}

REGRAS CRÍTICAS DE VERACIDADE (PREVENÇÃO TOTAL DE ALUCINAÇÕES):
1. Você está TERMINANTEMENTE PROIBIDO de inventar, misturar ou criar livros ou autores fictícios que não existem no mundo real.
2. Se a consulta for sobre uma obra fictícia ou inexistente, informe com transparência que ela não existe ou retorne uma lista vazia.
3. Se for um livro REAL ou Box Set REAL, retorne de 1 a 3 edições/livros com dados 100% reais e precisos.

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
    }

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
      throw new Error("O Gemini não retornou nenhuma edição do livro.");
    }

    const result = JSON.parse(textOutput.trim());
    return res.json({ books: result.books || [] });
  } catch (error: any) {
    console.error("Erro ao buscar detalhes do livro via Gemini:", error);
    return res.status(500).json({
      error: error.message || "Ocorreu um erro ao obter os detalhes do livro com Inteligência Artificial."
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
