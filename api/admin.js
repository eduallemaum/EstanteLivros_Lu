import { getAllUsers, getAccessLogs, upsertUser, removeUser, db } from "./db.js";
import { doc, getDoc } from "firebase/firestore";

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

  // Validate Admin PIN
  const userPinHeader = req.headers["x-family-pin"];
  if (!userPinHeader) {
    return res.status(401).json({ error: "Acesso administrativo não autorizado. PIN ausente." });
  }

  try {
    // Verify if there is an active Admin user with this PIN in Firestore
    const users = await getAllUsers(true);
    const adminUser = users.find(u => u.role === "admin" && u.pin === userPinHeader.trim() && u.active);
    
    if (!adminUser) {
      return res.status(403).json({ error: "Acesso administrativo negado. Código PIN de administrador incorreto ou inativo." });
    }

    // 1. GET Request: Return users list and access logs
    if (req.method === "GET") {
      const allUsers = await getAllUsers(true); // admin can view PINs to manage them
      const logs = await getAccessLogs();
      return res.json({
        success: true,
        users: allUsers,
        logs
      });
    }

    // 2. POST Request: Handle admin updates
    if (req.method === "POST") {
      const { action, username, pin, role, avatar, active } = req.body;

      if (!action) {
        return res.status(400).json({ error: "Ação não especificada." });
      }

      if (action === "upsert") {
        if (!username || !pin) {
          return res.status(400).json({ error: "Nome de usuário e PIN são obrigatórios para salvar." });
        }
        if (pin.trim().length !== 6 || !/^\d+$/.test(pin.trim())) {
          return res.status(400).json({ error: "O código PIN deve conter exatamente 6 dígitos numéricos." });
        }

        const result = await upsertUser(adminUser.username, username, pin, role, avatar, active);
        if (result.success) {
          return res.json({ success: true, message: `Perfil de ${username} atualizado com sucesso.` });
        }
        return res.status(500).json({ error: result.error });
      }

      if (action === "delete") {
        if (!username) {
          return res.status(400).json({ error: "Nome de usuário para exclusão não especificado." });
        }
        const result = await removeUser(username);
        if (result.success) {
          return res.json({ success: true, message: `Perfil de ${username} excluído.` });
        }
        return res.status(400).json({ error: result.error });
      }

      return res.status(400).json({ error: "Ação administrativa inválida." });
    }

    return res.status(405).json({ error: "Método não permitido." });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Erro interno no servidor administrativo." });
  }
}
