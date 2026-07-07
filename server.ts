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
    const key = process.env.GEMINI_API_KEY;
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

    const promptText = `Analise a imagem da prateleira de livros ou das lombadas fornecidas.
Identifique todos os livros físicos visíveis na imagem de forma precisa. Para cada livro identificado, forneça as seguintes informações em português brasileiro:
1. Título do livro (título oficial)
2. Autor ou autores do livro
3. Gênero literário correspondente (ex: Romance, Suspense, Fantasia, Ficção Científica, Desenvolvimento Pessoal, Poesia, Biografia, Clássico, etc.)
4. Número aproximado ou exato de páginas (seja razoável)
5. Uma sinopse breve, interessante, calorosa e envolvente do livro em português.
6. Status sugerido de leitura do livro ("Quero Ler").

Retorne obrigatoriamente uma lista de livros estruturada em JSON contendo esses campos de acordo com o esquema fornecido.`;

    const response = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        imagePart,
        { text: promptText }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          description: "Lista de livros identificados com seus respectivos metadados.",
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "Título do livro" },
              author: { type: Type.STRING, description: "Autor ou autores do livro" },
              genre: { type: Type.STRING, description: "Gênero literário predominante" },
              pages: { type: Type.INTEGER, description: "Número total aproximado de páginas" },
              synopsis: { type: Type.STRING, description: "Breve sinopse instigante em português" },
              status: { type: Type.STRING, description: "Status de leitura padrão, ex: 'Quero Ler'" }
            },
            required: ["title", "author", "genre", "pages", "synopsis", "status"]
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
