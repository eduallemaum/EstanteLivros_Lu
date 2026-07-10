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
    const { image, mimeType = "image/jpeg" } = req.body;

    if (!image) {
      return res.status(400).json({ error: "Nenhuma imagem fornecida em formato Base64." });
    }

    // Extract raw base64 data if it contains the data:image prefix
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const apiKey = process.env.USER_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "A variável de ambiente GEMINI_API_KEY não está configurada no servidor Vercel."
      });
    }

    const ai = new GoogleGenAI({ apiKey });

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

    const response = await generateContentWithRetry(ai, {
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
    return res.status(200).json({ books });
  } catch (error) {
    console.error("Erro ao analisar lombadas na Vercel:", error);
    return res.status(500).json({
      error: error.message || "Ocorreu um erro interno ao processar a imagem do livro."
    });
  }
}
