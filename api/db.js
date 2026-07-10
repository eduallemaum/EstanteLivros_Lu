import fs from "fs";
import path from "path";
import { initializeApp } from "firebase/app";
import { 
  initializeFirestore, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  addDoc, 
  collection, 
  query, 
  orderBy, 
  limit, 
  deleteDoc 
} from "firebase/firestore";

// Read Firebase config from the root of the project
const configPath = path.join(process.cwd(), "firebase-applet-config.json");
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

const app = initializeApp({
  apiKey: firebaseConfig.apiKey,
  authDomain: firebaseConfig.authDomain,
  projectId: firebaseConfig.projectId,
  storageBucket: firebaseConfig.storageBucket,
  messagingSenderId: firebaseConfig.messagingSenderId,
  appId: firebaseConfig.appId,
});

export const db = initializeFirestore(
  app,
  {},
  firebaseConfig.firestoreDatabaseId || "(default)"
);

// Helper to seed default users if the collection is empty
export async function seedUsersIfEmpty() {
  try {
    const usersCol = collection(db, "family_users");
    const snapshot = await getDocs(usersCol);
    if (snapshot.empty) {
      console.log("Seeding default family users to Firestore...");
      const defaultUsers = {
        "Lu": { username: "Lu", pin: "141203", role: "admin", avatar: "🐱", active: true },
        "Edu": { username: "Edu", pin: "123456", role: "admin", avatar: "🧔", active: true },
        "Convidado": { username: "Convidado", pin: "000000", role: "user", avatar: "📖", active: true }
      };

      for (const [username, userData] of Object.entries(defaultUsers)) {
        await setDoc(doc(db, "family_users", username), userData);
      }
      console.log("Default family users successfully seeded.");
    } else {
      // If collection is NOT empty, let's ensure "Lu" is upgraded to admin if she exists
      const luDocRef = doc(db, "family_users", "Lu");
      const luSnap = await getDoc(luDocRef);
      if (luSnap.exists()) {
        const luData = luSnap.data();
        if (luData.role !== "admin") {
          console.log("Upgrading Lu to admin role in Firestore...");
          await setDoc(luDocRef, { ...luData, role: "admin" });
          console.log("Lu successfully upgraded to admin.");
        }
      }

      // Also ensure "Edu" is upgraded to admin if he exists
      const eduDocRef = doc(db, "family_users", "Edu");
      const eduSnap = await getDoc(eduDocRef);
      if (eduSnap.exists()) {
        const eduData = eduSnap.data();
        if (eduData.role !== "admin") {
          console.log("Upgrading Edu to admin role in Firestore...");
          await setDoc(eduDocRef, { ...eduData, role: "admin" });
          console.log("Edu successfully upgraded to admin.");
        }
      }
    }
  } catch (error) {
    console.error("Error seeding default users:", error);
  }
}

// Ensure seeded on module load (asynchronously)
seedUsersIfEmpty();

// Fetch all users safely (with option to redact or include PINs)
export async function getAllUsers(includePins = false) {
  try {
    const usersCol = collection(db, "family_users");
    const snapshot = await getDocs(usersCol);
    const users = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (!includePins) {
        delete data.pin;
      }
      users.push(data);
    });
    return users;
  } catch (error) {
    console.error("Error fetching users:", error);
    return [];
  }
}

// Log a login/access attempt
export async function logAccessAttempt(username, success, details, req) {
  try {
    const userAgent = req.headers["user-agent"] || "Unknown";
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "Unknown";
    
    await addDoc(collection(db, "access_logs"), {
      timestamp: new Date().toISOString(),
      username: username || "Desconhecido",
      success,
      details,
      ip,
      userAgent
    });
  } catch (error) {
    console.error("Error logging access attempt:", error);
  }
}

// Verify a user PIN
export async function verifyPin(username, pin, req) {
  if (!username || !pin) return { success: false, error: "Nome de usuário e PIN são necessários." };
  
  const cleanUser = username.trim();
  const cleanPin = pin.trim();

  try {
    const userDocRef = doc(db, "family_users", cleanUser);
    const userDoc = await getDoc(userDocRef);

    if (!userDoc.exists()) {
      await logAccessAttempt(cleanUser, false, "Usuário não encontrado", req);
      return { success: false, error: "Perfil de usuário não encontrado." };
    }

    const userData = userDoc.data();
    if (!userData.active) {
      await logAccessAttempt(cleanUser, false, "Perfil desativado", req);
      return { success: false, error: "Este perfil está desativado." };
    }

    if (userData.pin === cleanPin) {
      await logAccessAttempt(cleanUser, true, "Login efetuado com sucesso", req);
      return { 
        success: true, 
        user: { 
          username: cleanUser, 
          role: userData.role || "user",
          avatar: userData.avatar || "📖"
        } 
      };
    } else {
      await logAccessAttempt(cleanUser, false, `Senha/PIN incorreta inserida: ${cleanPin}`, req);
      return { success: false, error: "Código PIN incorreto." };
    }
  } catch (error) {
    console.error("Error in verifyPin:", error);
    return { success: false, error: "Erro interno ao validar PIN." };
  }
}

// Fetch access logs (for Admin panel)
export async function getAccessLogs() {
  try {
    const logsCol = collection(db, "access_logs");
    // Standard firestore query
    const q = query(logsCol, orderBy("timestamp", "desc"), limit(50));
    const snapshot = await getDocs(q);
    const logs = [];
    snapshot.forEach((docSnap) => {
      logs.push({ id: docSnap.id, ...docSnap.data() });
    });
    return logs;
  } catch (error) {
    console.error("Error fetching access logs:", error);
    // Fallback if index is not ready yet, return unsorted
    try {
      const logsCol = collection(db, "access_logs");
      const snapshot = await getDocs(query(logsCol, limit(50)));
      const logs = [];
      snapshot.forEach((docSnap) => {
        logs.push({ id: docSnap.id, ...docSnap.data() });
      });
      return logs.sort((a,b) => b.timestamp.localeCompare(a.timestamp));
    } catch (e) {
      return [];
    }
  }
}

// Update or create user
export async function upsertUser(adminUser, username, pin, role, avatar, active = true) {
  try {
    const userDocRef = doc(db, "family_users", username.trim());
    const existing = await getDoc(userDocRef);
    
    const userData = {
      username: username.trim(),
      pin: pin.trim(),
      role: role || "user",
      avatar: avatar || "📖",
      active: active === undefined ? true : active
    };

    await setDoc(userDocRef, userData);
    return { success: true };
  } catch (error) {
    console.error("Error in upsertUser:", error);
    return { success: false, error: error.message };
  }
}

// Delete user
export async function removeUser(username) {
  try {
    const cleanUser = username.trim();
    if (cleanUser === "Edu") {
      return { success: false, error: "Não é possível excluir o moderador administrador principal (Edu)." };
    }
    await deleteDoc(doc(db, "family_users", cleanUser));
    return { success: true };
  } catch (error) {
    console.error("Error in removeUser:", error);
    return { success: false, error: error.message };
  }
}
