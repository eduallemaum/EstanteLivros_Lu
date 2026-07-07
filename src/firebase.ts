import { initializeApp } from 'firebase/app';
import { initializeFirestore } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp({
  apiKey: firebaseConfig.apiKey,
  authDomain: firebaseConfig.authDomain,
  projectId: firebaseConfig.projectId,
  storageBucket: firebaseConfig.storageBucket,
  messagingSenderId: firebaseConfig.messagingSenderId,
  appId: firebaseConfig.appId,
});

// Since Firestore might be provisioned with a custom database ID,
// we initialize Firestore with that specific databaseId.
export const db = initializeFirestore(
  app,
  {},
  firebaseConfig.firestoreDatabaseId || '(default)'
);
