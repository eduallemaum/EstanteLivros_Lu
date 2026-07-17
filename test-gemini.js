import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

// Force using the platform GEMINI_API_KEY
const key = process.env.GEMINI_API_KEY;
console.log("Using API Key starting with:", key ? key.substring(0, 10) : "undefined");

const ai = new GoogleGenAI({ apiKey: key });

async function run() {
  try {
    console.log("Calling Gemini 2.5 Flash / gemini-3.5-flash...");
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Diga 'Olá Mundo' em português",
    });
    console.log("Response text:", response.text);
    process.exit(0);
  } catch (err) {
    console.error("Gemini Error:", err);
    process.exit(1);
  }
}

run();
