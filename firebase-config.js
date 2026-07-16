// =====================================================================
//  PASTE YOUR OWN FIREBASE CONFIG BELOW — nothing else in this project
//  needs to change. See README.md for exactly how to get these values
//  (Firebase console → Project settings → your web app → SDK setup).
// =====================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD3EaSe-3NuYgyGeR0UVH7xPJXmZwfpafk",
  authDomain: "sharewithme-6f4ed.firebaseapp.com",
  projectId: "sharewithme-6f4ed",
  storageBucket: "sharewithme-6f4ed.firebasestorage.app",
  messagingSenderId: "27812116064",
  appId: "1:27812116064:web:e8aece494c7a5ff9dab505",
  measurementId: "G-JQQR4G45D2"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);

