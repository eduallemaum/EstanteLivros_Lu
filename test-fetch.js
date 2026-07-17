import dotenv from "dotenv";
dotenv.config();

const key = process.env.GEMINI_API_KEY;
console.log("Using API Key starting with:", key ? key.substring(0, 10) : "undefined");

const modelsToTest = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-2.5-flash", "gemini-3.5-flash", "gemini-flash-latest"];

async function run() {
  for (const modelName of modelsToTest) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`;
    try {
      console.log(`\nTesting model: ${modelName}...`);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Diga 'Olá Mundo' em português" }] }]
        })
      });
      
      console.log(`Status: ${response.status}`);
      const data = await response.json();
      if (response.ok) {
        console.log(`SUCCESS! Response:`, data.candidates?.[0]?.content?.parts?.[0]?.text);
      } else {
        console.log(`FAIL! Error:`, data.error?.message);
      }
    } catch (err) {
      console.error(`Error for ${modelName}:`, err.message);
    }
  }
  process.exit(0);
}

run();
