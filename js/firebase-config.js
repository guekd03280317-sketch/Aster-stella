// Aster Stella - Firebase 設定
// ステッラシステムの地図データ保存先（Realtime Database）。
//
// ビルド不要で GitHub Pages にそのまま載せられるよう、CDN の ES モジュールを使用。
// npm 版を使いたい場合は README を参照。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, remove, update, onValue, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyCjYUL9nzaE_JCVIIAc9rhBkHRNXurgKsQ",
  authDomain: "asteroides-a5ee1.firebaseapp.com",
  databaseURL: "https://asteroides-a5ee1-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "asteroides-a5ee1",
  storageBucket: "asteroides-a5ee1.firebasestorage.app",
  messagingSenderId: "674362912966",
  appId: "1:674362912966:web:a7d4cf91dd8a6c1cbb67c7",
  measurementId: "G-56V5NKYLQV"
};

const app = initializeApp(firebaseConfig);

// Realtime Database
export const db = getDatabase(app);
export { ref, set, get, remove, update, onValue, push };

// Analytics は対応環境（https など）でのみ初期化する。
// localhost / file:// では未対応のことがあるため、失敗しても無視する。
isSupported()
  .then((ok) => {
    if (ok) {
      try { getAnalytics(app); } catch (e) { /* noop */ }
    }
  })
  .catch(() => { /* noop */ });
