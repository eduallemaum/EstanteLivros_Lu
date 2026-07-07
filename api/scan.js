import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc } from 'firebase/firestore';

// Configuração idêntica à do seu servidor
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Permite que o servidor processe a requisição sem travar no tamanho
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '15mb',
    },
  },
};

export default async function handler(req, res) {
  // Garante os cabeçalhos de CORS para evitar bloqueios de segurança do navegador
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Nenhuma imagem foi enviada.' });
    }

    // Limpa cirurgicamente o cabeçalho "data:image/jpeg;base64," se ele existir
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

    // Prompt estrito para o Gemini retornar apenas o JSON puro, sem textos adicionais
    const promptText = "Analise a imagem fornecida. Identifique o título, autor, gênero e uma breve sinopse do livro. Retorne OBRIGATORIAMENTE apenas um array contendo um único objeto JSON seguindo exatamente este formato, sem markdown ou textos extras: [{\"titulo\": \"Nome do Livro\", \"autor\": \"Autor\", \"synopsis\": \"Resumo\", \"genero\": \"Ficção\", \"numeroPaginas\": 200}]";

    const apiKey = process.env.GEMINI_API_KEY;
    // Endpoint oficial e estável do Gemini 1.5 Flash
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: promptText },
            { inlineData: { mimeType: "image/jpeg", data: base64Data } }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errorLog = await response.text();
      console.error("Erro na API Gemini:", errorLog);
      return res.status(500).json({ error: 'O Gemini recusou a leitura do arquivo.' });
    }

    const data = await response.json();
    let responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!responseText) {
      return res.status(500).json({ error: 'A IA retornou uma resposta vazia.' });
    }

    // Remove marcações de bloco de código (```json ... ```) caso a IA as tenha colocado por teimosia
    responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    const booksDetected = JSON.parse(responseText);
    const booksArray = Array.isArray(booksDetected) ? booksDetected : [booksDetected];
    const booksCollection = collection(db, 'books');
    const addedBooks = [];

    // Salva os livros encontrados no seu Firestore automaticamente
    for (const book of booksArray) {
      const docRef = await addDoc(booksCollection, {
        title: book.titulo || 'Título Desconhecido',
        author: book.autor || 'Autor Desconhecido',
        synopsis: book.synopsis || '',
        genre: book.genero || 'Geral',
        pages: book.numeroPaginas ? Number(book.numeroPaginas) : 0,
        status: 'Quero Ler',
        coverUrl: '',
        createdAt: new Date().toISOString()
      });
      addedBooks.push({ id: docRef.id, ...book });
    }

    return res.status(200).json({ success: true, books: addedBooks });

  } catch (error) {
    console.error('Erro geral na API de Escaneamento:', error);
    return res.status(500).json({ error: 'Falha interna ao processar a imagem.' });
  }
}
