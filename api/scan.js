import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc } from 'firebase/firestore';
import { GoogleGenAI } from '@google/genai';

// Inicializa o Firebase usando as variáveis de ambiente da Vercel
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Inicializa a IA do Google com a chave da Vercel
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default async function handler(req, res) {
  // Garante que só aceitamos requisições do tipo POST (envio de dados)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { imageBase64 } = req.body; // Recebe a imagem convertida em texto do iPhone

    if (!imageBase64) {
      return res.status(400).json({ error: 'Nenhuma imagem foi enviada.' });
    }

    // Criamos as instruções milimétricas para o Gemini ler as lombadas
    const prompt = `Analise detalhadamente a imagem desta prateleira de livros. 
    Identifique todos os livros visíveis pelas suas lombadas.
    Para cada livro que você encontrar, pesquise os metadados corretos na internet.
    Retorne OBRIGATORIAMENTE apenas um array de objetos JSON válidos, sem formatações Markdown adicionais, seguindo exatamente este modelo:
    [
      {
        "titulo": "Nome do Livro",
        "autor": "Nome do Autor",
        "sinopse": "Breve resumo do livro encontrado na internet",
        "genero": "Ficção, Romance, Biografia, etc",
        "numeroPaginas": 350
      }
    ]`;

    // Chamamos o modelo Gemini 2.5 Flash enviando a imagem
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        prompt,
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBase64
          }
        }
      ]
    });

    // Limpa a resposta do Gemini para garantir que seja um JSON puro
    const cleanText = response.text.replace(/```json|```/g, '').trim();
    const livrosDetectados = JSON.parse(cleanText);

    // Salva cada livro encontrado na gaveta "meus_livros" do Cloud Firestore
    const livrosSalvos = [];
    for (const livro of livrosDetectados) {
      const docRef = await addDoc(collection(db, 'meus_livros'), {
        ...livro,
        statusLeitura: 'Quero Ler', // Status inicial padrão
        dataCadastro: new Date().toISOString()
      });
      livrosSalvos.push({ id: docRef.id, ...livro });
    }

    // Retorna o sucesso e a lista de livros para o iPhone atualizar a tela
    return res.status(200).json({ success: true, books: livrosSalvos });

  } catch (error) {
    console.error("Erro interno no servidor:", error);
    return res.status(500).json({ error: error.message });
  }
}
