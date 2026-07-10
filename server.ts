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

let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.USER_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("A variável de ambiente GEMINI_API_KEY não está configurada. Por favor, adicione seu chave da API Gemini nas configurações do AI Studio.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Helper for exponential backoff retry on transient errors (503, 429, etc.)
async function generateContentWithRetry(client: GoogleGenAI, params: any, maxRetries = 3, initialDelay = 1500): Promise<any> {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.models.generateContent(params);
    } catch (error: any) {
      const isTransient = 
        error.status === 503 || 
        error.code === 503 ||
        error.statusCode === 503 ||
        (error.message && error.message.includes("503")) ||
        (error.message && error.message.includes("high demand")) ||
        (error.message && error.message.includes("UNAVAILABLE")) ||
        error.status === 429 ||
        error.code === 429 ||
        (error.message && error.message.includes("429"));
        
      if (isTransient && attempt < maxRetries) {
        console.warn(`[Gemini API] Erro temporário detectado (Tentativa ${attempt}/${maxRetries}). Re-tentando em ${delay}ms... Motivo:`, error.message || error);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      } else {
        throw error;
      }
    }
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

    const client = getGeminiClient();

    const imagePart = {
      inlineData: {
        mimeType,
        data: base64Data,
      },
    };

    const promptText = `Analise a imagem fornecida (que pode conter a capa, a lombada, ou a contracapa com código de barras/ISBN de um único livro físico).
Identifique exatamente UM único livro físico presente na imagem de forma extremamente precisa.
Por favor, siga estas prioridades:
1. Tente encontrar um código de barras ou o número ISBN impresso (geralmente de 10 ou 13 dígitos, na contracapa, nas primeiras páginas ou próximo ao código de barras). Se encontrar o ISBN, use-o para buscar e identificar o livro com precisão absoluta.
2. Se nenhum ISBN ou código de barras estiver visível, analise a capa ou a lombada para identificar o livro (título e autor).

Para o livro identificado, forneça as seguintes informações em português brasileiro:
1. Título do livro (título oficial da edição brasileira)
2. Autor ou autores do livro
3. Gênero literário correspondente (ex: Romance, Suspense, Fantasia, Ficção Científica, Desenvolvimento Pessoal, Poesia, Biografia, Clássico, etc.)
4. Número aproximado ou exato de páginas (seja razoável)
5. Uma sinopse breve, interessante, calorosa e envolvente do livro em português.
6. Status sugerido de leitura do livro ("Quero Ler").
7. Código ISBN identificado (com 10 ou 13 dígitos, apenas números, sem traços ou espaços). Se nenhum for encontrado, deixe este campo vazio.

Retorne obrigatoriamente uma lista contendo exatamente este único livro estruturado em JSON de acordo com o esquema fornecido.`;

    const response = await generateContentWithRetry(client, {
      model: "gemini-3.5-flash",
      contents: [
        imagePart,
        { text: promptText }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          description: "Lista contendo exatamente um único livro identificado com seus respectivos metadados.",
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "Título do livro" },
              author: { type: Type.STRING, description: "Autor ou autores do livro" },
              genre: { type: Type.STRING, description: "Gênero literário predominante" },
              pages: { type: Type.INTEGER, description: "Número total aproximado de páginas" },
              synopsis: { type: Type.STRING, description: "Breve sinopse instigante em português" },
              status: { type: Type.STRING, description: "Status de leitura padrão, ex: 'Quero Ler'" },
              isbn: { type: Type.STRING, description: "Código ISBN de 10 ou 13 dígitos numéricos identificado, ou string vazia se não encontrado" }
            },
            required: ["title", "author", "genre", "pages", "synopsis", "status", "isbn"]
          }
        }
      }
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

    const client = getGeminiClient();

    const promptText = `Você é um bibliotecário e assistente literário profissional de alta precisão.
O usuário inseriu a seguinte consulta para encontrar um livro (pode ser um número de ISBN de 10 ou 13 dígitos, ou o título do livro com ou sem autor):

Consulta: "${searchQuery.trim()}"

Pesquise e encontre até 3 edições/versões diferentes ou livros correspondentes aproximados para esta consulta (por exemplo, diferentes editoras, edições de bolso, capa dura, ou edições nacionais).
Para cada livro/edição encontrado, forneça os seguintes metadados em português brasileiro de forma completa, calorosa e profissional:
1. title: O título oficial e correto do livro (em português brasileiro, se houver edição nacional).
2. author: O autor ou autores principais do livro (nome correto).
3. genre: O gênero literário correspondente (ex: Romance, Suspense, Fantasia, Ficção Científica, Desenvolvimento Pessoal, Poesia, Biografia, Clássico, etc.).
4. pages: O número total de páginas exato ou o mais próximo possível da realidade para essa edição.
5. synopsis: Uma sinopse breve, interessante, calorosa e envolvendo o livro em português brasileiro (sem dar spoilers do final).
6. status: Use obrigatoriamente 'Quero Ler' como padrão.
7. isbn: O código ISBN de 13 dígitos numéricos correto para esta edição específica (apenas números, sem traços ou espaços). Se nenhum for encontrado, deixe este campo vazio.
8. editionInfo: Um rótulo curto identificando esta edição para ajudar o usuário a escolher (ex: 'Editora Intrínseca, 2012', 'Capa Dura - HarperCollins, 2020', 'Edição Clássica', etc.).

Retorne obrigatoriamente a lista de até 3 edições/livros no formato JSON estruturado conforme o esquema de objeto contendo uma lista sob a chave 'books'.`;

    const response = await generateContentWithRetry(client, {
      model: "gemini-3.5-flash",
      contents: [{ text: promptText }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            books: {
              type: Type.ARRAY,
              description: "Lista de até 3 edições do livro correspondentes à pesquisa.",
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "Título correto do livro" },
                  author: { type: Type.STRING, description: "Autor(a) ou autores do livro" },
                  genre: { type: Type.STRING, description: "Gênero literário correspondente" },
                  pages: { type: Type.INTEGER, description: "Número de páginas total para esta edição" },
                  synopsis: { type: Type.STRING, description: "Sinopse calorosa e cativante em português" },
                  status: { type: Type.STRING, description: "Status padrão de leitura 'Quero Ler'" },
                  isbn: { type: Type.STRING, description: "Código ISBN de 10 ou 13 dígitos, apenas números, ou vazio" },
                  editionInfo: { type: Type.STRING, description: "Editora, ano ou tipo de edição curta" }
                },
                required: ["title", "author", "genre", "pages", "synopsis", "status", "isbn", "editionInfo"]
              }
            }
          },
          required: ["books"]
        }
      }
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

    const client = getGeminiClient();

    const promptText = `Você é um curador literário inteligente e carinhoso para a "Estante da Lu".
O usuário está visualizando os detalhes do livro "${title.trim()}" escrito por "${(author || '').trim() || 'Autor Desconhecido'}" (gênero: "${(genre || '').trim() || 'Geral'}").

Com base nessas informações, sugira exatamente 2 livros excelentes como sugestões de próximas leituras para a Lu, ou novidades/futuros lançamentos relacionados que combinem com este estilo.
Para cada um dos 2 livros sugeridos, forneça os seguintes metadados em português brasileiro:
1. title: O título do livro sugerido (título oficial no Brasil se houver).
2. author: O autor do livro.
3. reason: Uma justificativa carinhosa de por que ela vai amar ("Por que você vai amar: ..."), relacionando de forma inteligente com o estilo de "${title.trim()}".
4. tags: Uma lista de 2 a 3 palavras-chave curtas em português sobre o livro (ex: ["Clássico", "Reviravoltas", "Emocionante", "Lançamento"]).

Retorne obrigatoriamente a lista de exatamente 2 sugestões estruturadas em JSON de acordo com o esquema fornecido.`;

    const response = await generateContentWithRetry(client, {
      model: "gemini-3.5-flash",
      contents: [{ text: promptText }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendations: {
              type: Type.ARRAY,
              description: "Lista contendo exatamente 2 livros recomendados.",
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "Título do livro sugerido" },
                  author: { type: Type.STRING, description: "Autor do livro sugerido" },
                  reason: { type: Type.STRING, description: "Justificativa personalizada e carinhosa de por que a Lu vai amar o livro" },
                  tags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "Palavras-chave de destaque do livro sugerido"
                  }
                },
                required: ["title", "author", "reason", "tags"]
              }
            }
          },
          required: ["recommendations"]
        }
      }
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
