import dotenv from "dotenv";
dotenv.config();

const key = process.env.GEMINI_API_KEY;
const model = "gemini-3.5-flash";
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

async function testWithSchema() {
  console.log("Testing WITH responseSchema...");
  const config = {
    responseMimeType: "application/json",
    responseSchema: {
      type: "OBJECT",
      properties: {
        books: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              author: { type: "STRING" }
            },
            required: ["title", "author"]
          }
        }
      },
      required: ["books"]
    }
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Sugira 2 livros clássicos brasileiros." }] }],
        generationConfig: config
      })
    });
    console.log("With Schema - Status:", res.status);
    const data = await res.json();
    console.log("With Schema - Output:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("With Schema - Error:", err);
  }
}

async function testWithoutSchema() {
  console.log("\nTesting WITHOUT responseSchema (just responseMimeType: application/json)...");
  const config = {
    responseMimeType: "application/json"
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Sugira 2 livros clássicos brasileiros. Retorne obrigatoriamente um objeto JSON com uma chave 'books' contendo uma lista de objetos com 'title' e 'author'." }] }],
        generationConfig: config
      })
    });
    console.log("Without Schema - Status:", res.status);
    const data = await res.json();
    console.log("Without Schema - Output:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Without Schema - Error:", err);
  }
}

async function run() {
  await testWithoutSchema();
  await testWithSchema();
}

run();
