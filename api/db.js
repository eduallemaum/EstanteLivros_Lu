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
  updateDoc,
  collection, 
  query, 
  orderBy, 
  limit, 
  deleteDoc,
  serverTimestamp
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

// Standard user definitions and persistent default PIN rules
export const DEFAULT_USER_RULES = {
  "Eduardo": { username: "Eduardo", pin: "370450", role: "admin", avatar: "🧔", active: true },
  "Edu": { username: "Edu", pin: "370450", role: "admin", avatar: "🧔", active: true },
  "Luciana": { username: "Luciana", pin: "050412", role: "admin", avatar: "🐱", active: true },
  "Lu": { username: "Lu", pin: "050412", role: "admin", avatar: "🐱", active: true },
  "Augusto": { username: "Augusto", pin: "050412", role: "admin", avatar: "🧒", active: true },
  "Convidado": { username: "Convidado", pin: "000000", role: "user", avatar: "📖", active: true }
};

// Permanent master rule PINs for quick lookup
export const MASTER_RULE_PINS = {
  "eduardo": "370450",
  "edu": "370450",
  "luciana": "050412",
  "lu": "050412",
  "augusto": "050412",
  "convidado": "000000"
};

// Helper to seed and maintain default users and standard PIN rules in Firestore
export async function seedUsersIfEmpty() {
  try {
    console.log("[Users Rule] Synchronizing default family users and master PIN rules in Firestore...");

    for (const [key, defaultUser] of Object.entries(DEFAULT_USER_RULES)) {
      const userDocRef = doc(db, "family_users", key);
      const userSnap = await getDoc(userDocRef);

      if (!userSnap.exists()) {
        console.log(`[Users Rule] Creating missing user ${key} with rule PIN...`);
        await setDoc(userDocRef, defaultUser);
      } else {
        const existingData = userSnap.data();
        const updates = {};
        
        // Ensure core family members are admins
        if (defaultUser.role === "admin" && existingData.role !== "admin") {
          updates.role = "admin";
        }
        // Ensure active
        if (!existingData.active) {
          updates.active = true;
        }
        // If password is the obsolete temporary password (123456 or 141203) or missing, reset to rule PIN
        if (!existingData.pin || existingData.pin === "123456" || existingData.pin === "141203") {
          updates.pin = defaultUser.pin;
          console.log(`[Users Rule] Updating obsolete/missing PIN for ${key} to standard rule PIN (${defaultUser.pin}).`);
        }
        // Ensure avatar
        if (!existingData.avatar && defaultUser.avatar) {
          updates.avatar = defaultUser.avatar;
        }

        if (Object.keys(updates).length > 0) {
          await updateDoc(userDocRef, updates);
        }
      }
    }
    console.log("[Users Rule] Default family users and standard PIN rules verified.");
  } catch (error) {
    console.error("[Users Rule] Error synchronizing default users:", error);
  }
}

// Ensure seeded on module load (asynchronously)
seedUsersIfEmpty();

// Fetch all users safely (with option to redact or include PINs)
export async function getAllUsers(includePins = false) {
  try {
    const usersCol = collection(db, "family_users");
    const snapshot = await getDocs(usersCol);
    const rawUsers = [];
    
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      rawUsers.push({ id: docSnap.id, ...data, username: data.username || docSnap.id });
    });

    // Check if canonical profiles exist
    const hasEduardo = rawUsers.some(u => u.username.toLowerCase() === "eduardo");
    const hasLuciana = rawUsers.some(u => u.username.toLowerCase() === "luciana");

    const users = [];
    rawUsers.forEach((u) => {
      const lower = (u.username || "").toLowerCase();
      // In the user listing, avoid displaying redundant short aliases if canonical name exists
      if (hasEduardo && lower === "edu") return;
      if (hasLuciana && lower === "lu") return;

      const userObj = { ...u };
      if (!includePins) {
        delete userObj.pin;
      }
      users.push(userObj);
    });

    // Order: Luciana, Eduardo, Augusto, Convidado, others
    const sortOrder = { "luciana": 1, "lu": 1, "eduardo": 2, "edu": 2, "augusto": 3, "convidado": 4 };
    users.sort((a, b) => {
      const oA = sortOrder[a.username.toLowerCase()] || 99;
      const oB = sortOrder[b.username.toLowerCase()] || 99;
      if (oA !== oB) return oA - oB;
      return a.username.localeCompare(b.username);
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

// Helper to find a user doc, checking aliases
async function findUserDoc(username) {
  const clean = username.trim();
  const lower = clean.toLowerCase();

  // Try direct lookup first
  let docRef = doc(db, "family_users", clean);
  let docSnap = await getDoc(docRef);
  if (docSnap.exists()) return { docRef, docSnap, canonicalKey: clean };

  // Try known alias fallbacks
  let aliasKey = null;
  if (lower === "eduardo" || lower === "edu") {
    aliasKey = clean === "Edu" ? "Eduardo" : "Edu";
  } else if (lower === "luciana" || lower === "lu") {
    aliasKey = clean === "Lu" ? "Luciana" : "Lu";
  }

  if (aliasKey) {
    docRef = doc(db, "family_users", aliasKey);
    docSnap = await getDoc(docRef);
    if (docSnap.exists()) return { docRef, docSnap, canonicalKey: aliasKey };
  }

  return { docRef: null, docSnap: null, canonicalKey: clean };
}

// Verify a user PIN
export async function verifyPin(username, pin, req) {
  if (!username || !pin) return { success: false, error: "Nome de usuário e PIN são necessários." };
  
  const cleanUser = username.trim();
  const cleanPin = pin.trim();
  const lowerUser = cleanUser.toLowerCase();

  try {
    const { docSnap } = await findUserDoc(cleanUser);

    if (!docSnap || !docSnap.exists()) {
      await logAccessAttempt(cleanUser, false, "Usuário não encontrado", req);
      return { success: false, error: "Perfil de usuário não encontrado." };
    }

    const userData = docSnap.data();
    if (!userData.active) {
      await logAccessAttempt(cleanUser, false, "Perfil desativado", req);
      return { success: false, error: "Este perfil está desativado." };
    }

    // Check against stored PIN in DB OR standard master rule PIN (guarantees the rule is always honored)
    const masterRulePin = MASTER_RULE_PINS[lowerUser];
    const pinMatches = (userData.pin === cleanPin) || (masterRulePin && cleanPin === masterRulePin);

    if (pinMatches) {
      await logAccessAttempt(cleanUser, true, "Login efetuado com sucesso", req);
      return { 
        success: true, 
        user: { 
          username: userData.username || cleanUser, 
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
    const cleanUser = username.trim();
    const lower = cleanUser.toLowerCase();
    const defaultRulePin = MASTER_RULE_PINS[lower] || "000000";

    const userDocRef = doc(db, "family_users", cleanUser);
    const existing = await getDoc(userDocRef);
    
    const userData = {
      username: cleanUser,
      role: role || (lower === "eduardo" || lower === "edu" || lower === "luciana" || lower === "lu" || lower === "augusto" ? "admin" : "user"),
      avatar: avatar || (lower.includes("lu") ? "🐱" : lower.includes("edu") ? "🧔" : lower === "augusto" ? "🧒" : "📖"),
      active: active === undefined ? true : active,
      pin: defaultRulePin
    };

    const cleanPin = pin ? pin.trim() : "";
    if (cleanPin !== "") {
      userData.pin = cleanPin;
    } else if (existing.exists() && existing.data().pin) {
      userData.pin = existing.data().pin;
    }

    await setDoc(userDocRef, userData);

    // Keep aliases synced if updating Eduardo or Luciana
    if (lower === "eduardo" || lower === "edu") {
      const aliasName = lower === "eduardo" ? "Edu" : "Eduardo";
      await setDoc(doc(db, "family_users", aliasName), { ...userData, username: aliasName });
    } else if (lower === "luciana" || lower === "lu") {
      const aliasName = lower === "luciana" ? "Lu" : "Luciana";
      await setDoc(doc(db, "family_users", aliasName), { ...userData, username: aliasName });
    }

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
    const lower = cleanUser.toLowerCase();
    if (lower === "edu" || lower === "eduardo") {
      return { success: false, error: "Não é possível excluir o moderador administrador Eduardo." };
    }
    if (lower === "lu" || lower === "luciana") {
      return { success: false, error: "Não é possível excluir a proprietária e moderadora Luciana." };
    }
    await deleteDoc(doc(db, "family_users", cleanUser));
    return { success: true };
  } catch (error) {
    console.error("Error in removeUser:", error);
    return { success: false, error: error.message };
  }
}

// ---------------- BOOKS CRUD ----------------
let booksCache = null;
let wishlistCache = null;

// Fetch all books from Firestore
export async function getBooks() {
  try {
    const booksCol = collection(db, "books");
    const snapshot = await getDocs(booksCol);
    const books = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      let createdAtStr = new Date().toISOString();
      if (data.createdAt) {
        if (typeof data.createdAt.toDate === "function") {
          createdAtStr = data.createdAt.toDate().toISOString();
        } else if (typeof data.createdAt === "string") {
          createdAtStr = data.createdAt;
        }
      }
      books.push({
        id: docSnap.id,
        ...data,
        createdAt: createdAtStr
      });
    });

    // Sort descending by createdAt
    books.sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    booksCache = books;
    return books;
  } catch (error) {
    console.error("Error fetching books from Firestore:", error);
    if (booksCache && booksCache.length > 0) {
      console.log(`[Cache Fallback] Returning ${booksCache.length} cached books due to Firestore notice.`);
      return booksCache;
    }
    throw error;
  }
}

// Add a new book to Firestore
export async function addBook(bookData) {
  try {
    const cleanData = { ...bookData };
    delete cleanData.id;

    // Sanitize values
    if (cleanData.pages) cleanData.pages = Number(cleanData.pages) || 0;
    if (cleanData.rating) cleanData.rating = Number(cleanData.rating) || 0;
    if (cleanData.inBoxSet !== undefined) cleanData.inBoxSet = Boolean(cleanData.inBoxSet);

    const docRef = await addDoc(collection(db, "books"), {
      ...cleanData,
      createdAt: serverTimestamp()
    });

    return {
      id: docRef.id,
      ...cleanData,
      createdAt: new Date().toISOString()
    };
  } catch (error) {
    console.error("Error adding book to Firestore:", error);
    throw error;
  }
}

// Update an existing book in Firestore
export async function updateBook(id, bookData) {
  try {
    const cleanData = { ...bookData };
    delete cleanData.id;

    if (cleanData.pages !== undefined) cleanData.pages = Number(cleanData.pages) || 0;
    if (cleanData.rating !== undefined) cleanData.rating = Number(cleanData.rating) || 0;
    if (cleanData.inBoxSet !== undefined) cleanData.inBoxSet = Boolean(cleanData.inBoxSet);

    const bookRef = doc(db, "books", id);
    await updateDoc(bookRef, {
      ...cleanData,
      updatedAt: serverTimestamp()
    });

    return { success: true, id, ...cleanData };
  } catch (error) {
    console.error("Error updating book in Firestore:", error);
    throw error;
  }
}

// Delete a book from Firestore
export async function deleteBook(id) {
  try {
    const bookRef = doc(db, "books", id);
    await deleteDoc(bookRef);
    return { success: true, id };
  } catch (error) {
    console.error("Error deleting book from Firestore:", error);
    throw error;
  }
}

// ---------------- WISHLIST CRUD ----------------

// Fetch all wishlist items from Firestore
export async function getWishlist() {
  try {
    const wishlistCol = collection(db, "wishlist");
    const snapshot = await getDocs(wishlistCol);
    const wishlist = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      let createdAtStr = new Date().toISOString();
      if (data.createdAt) {
        if (typeof data.createdAt.toDate === "function") {
          createdAtStr = data.createdAt.toDate().toISOString();
        } else if (typeof data.createdAt === "string") {
          createdAtStr = data.createdAt;
        }
      }
      wishlist.push({
        id: docSnap.id,
        ...data,
        createdAt: createdAtStr
      });
    });

    wishlist.sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    wishlistCache = wishlist;
    return wishlist;
  } catch (error) {
    console.error("Error fetching wishlist from Firestore:", error);
    if (wishlistCache && wishlistCache.length > 0) {
      console.log(`[Cache Fallback] Returning ${wishlistCache.length} cached wishlist items.`);
      return wishlistCache;
    }
    throw error;
  }
}

// Add item to wishlist
export async function addWishlist(itemData) {
  try {
    const cleanData = { ...itemData };
    delete cleanData.id;

    const docRef = await addDoc(collection(db, "wishlist"), {
      ...cleanData,
      createdAt: serverTimestamp()
    });

    return {
      id: docRef.id,
      ...cleanData,
      createdAt: new Date().toISOString()
    };
  } catch (error) {
    console.error("Error adding to wishlist in Firestore:", error);
    throw error;
  }
}

// Delete item from wishlist
export async function deleteWishlist(id) {
  try {
    const itemRef = doc(db, "wishlist", id);
    await deleteDoc(itemRef);
    return { success: true, id };
  } catch (error) {
    console.error("Error deleting wishlist item from Firestore:", error);
    throw error;
  }
}

