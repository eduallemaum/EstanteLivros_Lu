import { getWishlist, addWishlist, deleteWishlist } from "./db.js";

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
      const wishlist = await getWishlist();
      return res.status(200).json({ success: true, wishlist });
    }

    if (req.method === "POST") {
      const itemData = req.body;
      if (!itemData || !itemData.title) {
        return res.status(400).json({ error: "Título do livro desejado é obrigatório." });
      }
      const createdItem = await addWishlist(itemData);
      return res.status(201).json({ success: true, item: createdItem });
    }

    if (req.method === "DELETE") {
      if (!id) {
        return res.status(400).json({ error: "ID do item não fornecido." });
      }
      await deleteWishlist(id);
      return res.status(200).json({ success: true, id });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error(`Error in /api/wishlist [${req.method}]:`, error);
    return res.status(500).json({ error: error.message || "Erro interno ao processar lista de desejos." });
  }
}
