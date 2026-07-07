import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc } from 'firebase/firestore';

// Inicializa o Firebase usando as variáveis de ambiente da Vercel
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export default async function handler(req, res) {
  // Garante que só aceitamos requisições do tipo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Nenhuma imagem foi enviada.' });
    }

    // Remove metadados do base64 se existirem
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const prompt = `Analise detalhadamente a imagem desta prateleira ou capa de livro. 
    Identifique os livros visíveis. Para cada livro que você encontrar, pesquise os metadados corretos na internet.
    Retorne OBRIGATORIAMENTE apenas um array de objetos JSON válidos, sem formatações Markdown adicionais, seguindo exatamente este modelo:
    [
      {
        "titulo": "Nome do Livro",
        "autor": "Nome do Autor",
        "synopsis": "Breve resumo do livro encontrado na internet",
        "genero": "Ficção, Romance, Biografia, etc",
        "numeroPaginas": 350
      }
    ]`;

    // Chamada universal e direta da API do Gemini sem depender de travas do SDK rígido
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Data
              }
            }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Erro na resposta do Gemini:", errorText);
      return res.status(500).json({ error: 'Erro na comunicação direta com o Gemini.' });
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!responseText) {
      return res.status(500).json({ error: 'O Gemini não retornou um texto legível.' });
    }

    // Converte a string JSON retornada pelo Gemini em Objeto JavaScript
    const booksDetected = JSON.parse(responseText.trim());

    // Se tudo estiver certo, salva os livros automaticamente no Firestore da Lu
    const addedBooks = [];
    const booksCollection = collection(db, 'books');

    // Se veio como objeto único, transforma em array
    const booksArray = Array.isArray(booksDetected) ? booksDetected : [booksDetected];

    for (const book of booksArray) {
      const docRef = await addDoc(booksCollection, {
        title: book.titulo || 'Título Desconhecido',
        author: book.autor || 'Autor Desconhecido',
        synopsis: book.synopsis || '',
        genre: book.genero || 'Não classificado',
        pages: book.numeroPaginas ? Number(book.numeroPaginas) : 0,
        status: 'Quero Ler', // Padrão inicial
        coverUrl: '', // O front-end cuidará de buscar a capa via API pública usando o título depois
        createdAt: new Date().toISOString()
      });
      addedBooks.push({ id: docRef.id, ...book });
    }

    return res.status(200).json({ success: true, books: addedBooks });

  } catch (error) {
    console.error('Erro interno na API de scan:', error);
    return res.status(500).json({ error: 'Falha interna ao processar a imagem.' });
  }
}
