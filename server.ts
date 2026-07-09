import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

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

// API to scan books using Gemini 2.5 Flash (via 'gemini-3.5-flash' alias as per guidelines)
app.post("/api/scan", async (req, res) => {
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
app.post("/api/book-info", async (req, res) => {
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
