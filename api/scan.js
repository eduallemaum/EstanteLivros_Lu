import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Aumenta a tolerância de processamento da Vercel para imagens grandes
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Nenhuma imagem foi enviada.' });
    }

    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

    const promptText = "Analise a imagem deste livro. Identifique o título, autor, gênero e uma breve sinopse. Retorne OBRIGATORIAMENTE apenas um array contendo um objeto JSON seguindo exatamente este modelo, sem markdown ou caracteres extras: [{\"titulo\": \"Nome\", \"autor\": \"Autor\", \"synopsis\": \"Resumo\", \"genero\": \"Ficção\", \"numeroPaginas\": 200}]";

    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

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
      const errLog = await response.text();
      console.error("Erro na API Gemini:", errLog);
      return res.status(500).json({ error: 'Falha na comunicação com a IA.' });
    }

    const data = await response.json();
    let responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!responseText) {
      return res.status(500).json({ error: 'Resposta nula da IA.' });
    }

    // Garante a extração limpa do formato JSON independente da resposta
    responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    const booksDetected = JSON.parse(responseText);
    const booksArray = Array.isArray(booksDetected) ? booksDetected : [booksDetected];
    const booksCollection = collection(db, 'books');
    const addedBooks = [];

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
    console.error('Erro geral no Handler:', error);
    return res.status(500).json({ error: 'Erro ao processar imagem.' });
  }
}
