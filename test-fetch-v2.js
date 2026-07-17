import dotenv from "dotenv";
dotenv.config();

const key = process.env.GEMINI_API_KEY || process.env.USER_GEMINI_API_KEY;
console.log("Using API Key starting with:", key ? key.substring(0, 10) : "undefined");
console.log("GEMINI_API_KEY exists?", !!process.env.GEMINI_API_KEY);
console.log("USER_GEMINI_API_KEY exists?", !!process.env.USER_GEMINI_API_KEY);

const model = "gemini-3.5-flash";
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const promptText = `Sugira exatamente 2 livros excelentes como sugestões de próximas leituras. Retorne em JSON de acordo com o esquema fornecido.`;

const contents = [
  {
    parts: [
      { text: promptText }
    ]
  }
];

const config = {
  responseMimeType: "application/json",
  responseSchema: {
    type: "OBJECT",
    properties: {
      recommendations: {
        type: "ARRAY",
        description: "Lista contendo exatamente 2 livros recomendados.",
        items: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Título do livro sugerido" },
            author: { type: "STRING", description: "Autor do livro sugerido" },
            reason: { type: "STRING", description: "Justificativa personalizada" },
            tags: {
              type: "ARRAY",
              items: { type: "STRING" }
            }
          },
          required: ["title", "author", "reason", "tags"]
        }
      }
    },
    required: ["recommendations"]
  }
};

async function run() {
  try {
    console.log("Sending fetch request...");
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

    console.log("HTTP status code:", res.status);
    const data = await res.json();
    console.log("Response JSON:", JSON.stringify(data, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("Error occurred:", err);
    process.exit(1);
  }
}

run();
