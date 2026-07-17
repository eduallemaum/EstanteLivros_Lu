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

// API to prefill book details by ISBN or Title using Gemini 2.5 Flash (gemini-3.5-flash)
app.post("/api/book-info", validatePin, async (req, res) => {
  try {
    const { query: searchQuery } = req.body;

    if (!searchQuery || !searchQuery.trim()) {
      return res.status(400).json({ error: "Nenhum ISBN ou título do livro fornecido." });
    }

    let brasilApiData: any = null;
    const cleanedQuery = searchQuery.trim().replace(/[^0-9]/g, "");
    const isIsbn = (cleanedQuery.length === 10 || cleanedQuery.length === 13) && /^\d+$/.test(cleanedQuery);

    if (isIsbn) {
      try {
        console.log(`Buscando ISBN ${cleanedQuery} na BrasilAPI...`);
        const bRes = await fetch(`https://brasilapi.com.br/api/isbn/v1/${cleanedQuery}`);
        if (bRes.ok) {
          brasilApiData = await bRes.json();
          console.log("Sucesso ao obter dados do livro da BrasilAPI:", brasilApiData);
        } else {
          console.log(`BrasilAPI retornou status ${bRes.status} para o ISBN ${cleanedQuery}`);
        }
      } catch (err) {
        console.error("Falha ao consultar BrasilAPI:", err);
      }
    }

    let promptText = "";
    if (brasilApiData) {
      const bAuthors = Array.isArray(brasilApiData.authors) ? brasilApiData.authors.join(", ") : (brasilApiData.authors || "Não informado");
      promptText = `Você é um bibliotecário e assistente literário profissional de alta precisão.
O usuário buscou o ISBN "${cleanedQuery}" na base nacional de livros do Brasil (BrasilAPI), que retornou com sucesso os seguintes metadados oficiais:
- Título Oficial: "${brasilApiData.title || ''}"
- Autor(es): "${bAuthors}"
- Editora Oficial: "${brasilApiData.publisher || ''}"
- Ano de Lançamento: "${brasilApiData.year || ''}"
- Páginas: ${brasilApiData.page_count || 0}
- Sinopse (se houver): "${brasilApiData.synopsis || ''}"

Seu trabalho é gerar uma resposta no formato JSON estruturado usando os metadados reais acima. Para os campos abaixo, use sua inteligência artificial para preencher/complementar:
1. "synopsis": Se a sinopse fornecida acima for vazia ou curta demais, elabore uma sinopse cativante, calorosa, interessante e envolvendo o livro em português brasileiro (sem spoilers). Se a original for boa, preserve-a ou enriqueça-a.
2. "genre": Estime o gênero literário correto baseado na obra (ex: Romance, Suspense, Fantasia, Ficção Científica, Desenvolvimento Pessoal, Poesia, Biografia, Clássico, etc.).
3. "inBoxSet", "boxSetName", "boxSetVolume": Verifique com muita atenção se este título/ISBN de fato pertence a um Box Set, Coleção ou Trilogia de livros famosa (por exemplo, "Box Sherlock Holmes", "Box Trilogia Espacial", "Box Harry Potter").

Caso o título ou os metadados indiquem que esta consulta/ISBN se refere a um Box Set completo ou coleção contendo múltiplos volumes/livros (por exemplo, contendo termos como "Box", "Coleção", "Trilogia", "Kit", "Volumes"):
Você deve obrigatoriamente retornar na lista "books" múltiplos objetos correspondentes:
- Primeiro, um objeto que represente o "Box" em si (o pacote completo/bundle), com o título indicando que é o Box (ex: "Box Harry Potter - Coleção Completa"), "boxSetVolume" como "Completo" ou "Box" e "inBoxSet": true.
- Depois, inclua cada um dos livros individuais pertencentes a este Box Set (os volumes que o compõem), ordenados por volume.
- Para todos esses registros (tanto o Box quanto os livros individuais), marque "inBoxSet": true e preencha "boxSetName" com EXATAMENTE o mesmo nome (ex: "Box Harry Potter") para que o sistema possa agrupá-los e linká-los perfeitamente.

Se for um livro individual normal, forneça de 1 a 3 edições/versões correspondentes, com "inBoxSet": false (ou preenchendo as chaves correspondentes se ele pertencer a alguma coleção famosa).

Forneça a resposta estruturada estritamente em um objeto JSON com a chave "books", contendo uma lista de objetos conforme o formato abaixo:

{
  "books": [
    {
      "title": "${(brasilApiData.title || '').replace(/"/g, '\\"')}",
      "author": "${bAuthors.replace(/"/g, '\\"')}",
      "genre": "Gênero estimado",
      "pages": ${brasilApiData.page_count || 0},
      "synopsis": "Sua sinopse bem elaborada aqui",
      "status": "Quero Ler",
      "isbn": "${cleanedQuery}",
      "editionInfo": "${(brasilApiData.publisher || '').replace(/"/g, '\\"')}${brasilApiData.year ? `, ${brasilApiData.year}` : ''}",
      "publisher": "${(brasilApiData.publisher || '').replace(/"/g, '\\"')}",
      "publishYear": "${brasilApiData.year ? String(brasilApiData.year) : ''}",
      "edition": "Edição Brasileira",
      "inBoxSet": false,
      "boxSetName": "",
      "boxSetVolume": ""
    }
  ]
}

Atenção especial:
- "pages" deve ser um número inteiro.
- "inBoxSet" deve ser boolean.
- Retorne apenas o JSON puro, sem textos explicativos adicionais ou blocos de código markdown.`;
    } else {
      promptText = `Você é um bibliotecário e assistente literário profissional de alta precisão.
O usuário inseriu a seguinte consulta para encontrar um livro (pode ser um número de ISBN de 10 ou 13 dígitos, ou o título do livro com ou sem autor):

Consulta: "${searchQuery.trim()}"

Caso a consulta seja sobre um "Box Set", "Box de Livros" ou "Coleção" (por exemplo, "Box Harry Potter", "Trilogia O Senhor dos Anéis", "Box Sherlock Holmes"), você deve obrigatoriamente retornar na lista "books" múltiplos objetos correspondentes:
1. Primeiro, um objeto que represente o "Box" em si (o pacote completo/bundle), com o título indicando que é o Box (ex: "Box Harry Potter - Coleção Completa") e o campo "boxSetVolume" definido como "Completo" ou "Box".
2. Depois, inclua cada um dos livros individuais pertencentes a este Box Set (os volumes que o compõem), ordenados por volume.
3. Para todos esses registros (tanto o Box quanto os livros individuais), marque "inBoxSet": true e preencha "boxSetName" com EXATAMENTE o mesmo nome (ex: "Box Harry Potter") para que o sistema possa agrupá-los e linká-los perfeitamente.

Se a consulta for sobre um livro individual normal, pesquise e encontre até 3 edições/versões diferentes ou livros correspondentes aproximados para esta consulta (por exemplo, diferentes editoras, edições de bolso, capa dura, ou edições nacionais).

Para cada livro/edição/volume encontrado, forneça os seguintes metadados em português brasileiro estruturados estritamente em um objeto JSON com a chave "books", contendo uma lista de objetos conforme o formato abaixo:

{
  "books": [
    {
      "title": "Título oficial e correto do livro em português brasileiro",
      "author": "Nome do autor ou autores principais",
      "genre": "Gênero literário (ex: Romance, Suspense, Fantasia, Ficção Científica, Desenvolvimento Pessoal, Poesia, Biografia, Clássico, etc.)",
      "pages": 250,
      "synopsis": "Uma sinopse breve, interessante, calorosa e envolvendo o livro em português brasileiro (sem dar spoilers do final)",
      "status": "Quero Ler",
      "isbn": "9781234567890",
      "editionInfo": "Rótulo curto identificando esta edição (ex: 'Editora Intrínseca, 2012', 'Capa Dura - HarperCollins, 2020')",
      "publisher": "Nome da editora",
      "publishYear": "Ano de lançamento (formato string, ex: '2012')",
      "edition": "Edição ou tipo da edição (ex: '1ª Edição', 'Edição de Luxo')",
      "inBoxSet": false,
      "boxSetName": "Nome da coleção ou box se aplicável (ex: 'Box Sherlock Holmes', 'Box Coleção Agatha Christie')",
      "boxSetVolume": "Volume ou número do box se aplicável (ex: 'Vol. 1', 'Vol. 2', 'Box')"
    }
  ]
}

Atenção especial:
- "pages" deve ser um número inteiro.
- "inBoxSet" deve ser boolean (true se pertencer a uma coleção ou box set como Sherlock Holmes, Agatha Christie, O Senhor dos Anéis).
- Todos os demais campos devem ser strings. Se algum campo for desconhecido, retorne uma string vazia "".
- Retorne apenas o JSON puro, sem textos adicionais, explicações ou blocos de código markdown.`;
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

    const promptText = `Você é um curador literário inteligente e carinhoso para a "Estante da Lu".
O usuário está visualizando os detalhes do livro "${title.trim()}" escrito por "${(author || '').trim() || 'Autor Desconhecido'}" (gênero: "${(genre || '').trim() || 'Geral'}").

Com base nessas informações, sugira exatamente 2 livros excelentes como sugestões de próximas leituras para a Lu, ou novidades/futuros lançamentos relacionados que combinem com este estilo.
Você deve retornar obrigatoriamente um objeto JSON contendo exatamente 2 sugestões estruturadas sob a chave "recommendations" exatamente conforme o formato abaixo:

{
  "recommendations": [
    {
      "title": "Título do livro sugerido",
      "author": "Nome do autor",
      "reason": "Por que você vai amar: justificativa carinhosa de por que ela vai amar, relacionando com o estilo de ${title.trim()}",
      "tags": ["Tag1", "Tag2"]
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
