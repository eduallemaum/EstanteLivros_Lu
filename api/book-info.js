import { GoogleGenAI, Type } from "@google/genai";
import { getAllUsers } from "./db.js";

// Helper for exponential backoff retry on transient errors (503, 429, etc.)
async function generateContentWithRetry(client, params, maxRetries = 3, initialDelay = 1500) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.models.generateContent(params);
    } catch (error) {
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

export default async function handler(req, res) {
  // Set CORS headers for Vercel serverless environment
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Secure endpoints with X-Family-PIN header validation against Firestore users
  const userPinHeader = req.headers["x-family-pin"];
  if (!userPinHeader) {
    return res.status(401).json({ error: "Acesso não autorizado. Código PIN ausente." });
  }

  const users = await getAllUsers(true);
  const isValidUser = users.some(u => u.pin === userPinHeader.trim() && u.active);

  if (!isValidUser) {
    return res.status(401).json({ error: "Acesso não autorizado. Código PIN inválido ou inativo." });
  }

  try {
    const { query: searchQuery } = req.body;

    if (!searchQuery || !searchQuery.trim()) {
      return res.status(400).json({ error: "Nenhum ISBN ou título do livro fornecido." });
    }

    const apiKey = process.env.USER_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "A variável de ambiente GEMINI_API_KEY não está configurada no servidor Vercel."
      });
    }

    const ai = new GoogleGenAI({ apiKey });

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

    const response = await generateContentWithRetry(ai, {
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
    return res.status(200).json({ books: result.books || [] });
  } catch (error) {
    console.error("Erro ao buscar detalhes do livro via Gemini na Vercel:", error);
    return res.status(500).json({
      error: error.message || "Ocorreu um erro ao obter os detalhes do livro com Inteligência Artificial."
    });
  }
}
