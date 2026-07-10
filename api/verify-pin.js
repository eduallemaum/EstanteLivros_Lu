import { verifyPin, getAllUsers } from "./db.js";

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

  if (req.method === "GET") {
    try {
      const users = await getAllUsers(false); // safe list of profiles (pins are deleted)
      return res.status(200).json({ success: true, users });
    } catch (error) {
      return res.status(500).json({ error: error.message || "Erro ao obter os perfis de usuário." });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const { username, pin } = req.body;

    if (!username || !pin) {
      return res.status(400).json({ error: "Nome de usuário e PIN de 6 dígitos são necessários." });
    }

    const result = await verifyPin(username, pin, req);

    if (result.success) {
      return res.json({ 
        success: true, 
        user: { 
          username: result.user.username,
          role: result.user.role,
          avatar: result.user.avatar,
          token: Buffer.from(`${result.user.username}:${pin}`).toString("base64") 
        } 
      });
    }

    return res.status(401).json({ error: result.error || "Código PIN incorreto." });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Erro interno no servidor de autenticação." });
  }
}
