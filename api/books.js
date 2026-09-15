import { getBooks, addBook, updateBook, deleteBook } from "./db.js";

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, X-Family-PIN"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const id = req.query.id || (req.body && req.body.id);

  try {
    if (req.method === "GET") {
      const books = await getBooks();
      return res.status(200).json({ success: true, books });
    }

    if (req.method === "POST") {
      const bookData = req.body;
      if (!bookData || !bookData.title) {
        return res.status(400).json({ error: "O título do livro é obrigatório." });
      }
      const createdBook = await addBook(bookData);
      return res.status(201).json({ success: true, book: createdBook });
    }

    if (req.method === "PUT") {
      if (!id) {
        return res.status(400).json({ error: "ID do livro não fornecido." });
      }
      const updated = await updateBook(id, req.body);
      return res.status(200).json({ success: true, book: updated });
    }

    if (req.method === "DELETE") {
      if (!id) {
        return res.status(400).json({ error: "ID do livro não fornecido." });
      }
      await deleteBook(id);
      return res.status(200).json({ success: true, id });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error(`Error in /api/books [${req.method}]:`, error);
    return res.status(500).json({ error: error.message || "Erro interno ao processar livros." });
  }
}
