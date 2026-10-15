// Firebase project keys (Project settings > Your apps > Web app). These identify the project and are
// meant to be public; the data is protected by firestore.rules and sign-in.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyA8ZcghTnu-k3iQ01JuBeXPl44Pj0pwDDg",
  authDomain: "shahm-debts-a080e.firebaseapp.com",
  projectId: "shahm-debts-a080e",
  storageBucket: "shahm-debts-a080e.firebasestorage.app",
  messagingSenderId: "484305962591",
  appId: "1:484305962591:web:1be0bba9352d4255d37dea"
};

// Address of the small server that reads ledger photos (worker/). Empty until it is deployed.
window.AI_URL = "https://shahm-ai.hydrzyd83.workers.dev";

// Other shops sign up in this same app ("سجّل محلك"); each gets its own notebook under shops/{id}, opened once the owner
// activates it in Settings > المحلات. Shop copies built by scripts/build-shop.mjs leave this out (one shop each).
window.MULTI_SHOP = true;
