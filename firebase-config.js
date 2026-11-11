/* =====================================================================
   firebase-config.js
   生産管理システム Firebase本番接続設定（Firebase Spark無料プラン対応）
   ===================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCTcQwbiMyOypvFPonJlU7pviQuZMCru5Q",
  authDomain: "seisankanri-suzuka-aa08c.firebaseapp.com",
  projectId: "seisankanri-suzuka-aa08c",
  storageBucket: "seisankanri-suzuka-aa08c.firebasestorage.app",
  messagingSenderId: "840235411019",
  appId: "1:840235411019:web:bf88a24d1e97948d848fce"
};

window.firebaseConfig = firebaseConfig;
window.__FIREBASE_CONFIG__ = firebaseConfig;

window.APP_CONFIG = {
  // 動作モード: 本番用Firestore接続（モックモード不可）
  mode: 'firestore',

  // 社員ID用ドメイン（Firebase Authentication認証用）
  idDomain: 'seisankanri-suzuka-aa08c.firebaseapp.com',

  // Firebase Web SDK のバージョン（13.2.0に統一）
  sdkVersion: '13.2.0',

  // オフラインキャッシュ
  persistentCache: true,

  // Firebase 本番プロジェクト設定
  firebase: firebaseConfig
};

