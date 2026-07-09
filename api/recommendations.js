import { GoogleGenAI, Type } from "@google/genai";

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

  try {
    const { title, author, genre } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "O título do livro é necessário para gerar sugestões." });
    }

    const apiKey = process.env.USER_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "A variável de ambiente GEMINI_API_KEY não está configurada no servidor Vercel."
      });
    }

    const ai = new GoogleGenAI({ apiKey });

    const promptText = `Você é um curador literário inteligente e carinhoso para a "Estante da Lu".
O usuário está visualizando os detalhes do livro "${title.trim()}" escrito por "${(author || '').trim() || 'Autor Desconhecido'}" (gênero: "${(genre || '').trim() || 'Geral'}").

Com base nessas informações, sugira exatamente 2 livros excelentes como sugestões de próximas leituras para a Lu, ou novidades/futuros lançamentos relacionados que combinem com este estilo.
Para cada um dos 2 livros sugeridos, forneça os seguintes metadados em português brasileiro:
1. title: O título do livro sugerido (título oficial no Brasil se houver).
2. author: O autor do livro.
3. reason: Uma justificativa carinhosa de por que ela vai amar ("Por que você vai amar: ..."), relacionando de forma inteligente com o estilo de "${title.trim()}".
4. tags: Uma lista de 2 a 3 palavras-chave curtas em português sobre o livro (ex: ["Clássico", "Reviravoltas", "Emocionante", "Lançamento"]).

Retorne obrigatoriamente a lista de exatamente 2 sugestões estruturadas em JSON de acordo com o esquema fornecido.`;

    const response = await generateContentWithRetry(ai, {
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
  } catch (error) {
    console.error("Erro ao gerar sugestões de leitura via Gemini:", error);
    return res.status(500).json({
      error: error.message || "Ocorreu um erro ao obter recomendações literárias."
    });
  }
}
