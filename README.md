# 生産管理システム（Firebase無料プラン＆GitHub Pages対応版）

鉄骨・厚板・鋼材加工工場向けの生産管理・工程管理・配達表リアルタイム同期Webシステムです。
Firebase Spark無料枠（月額0円）およびGitHub Pages（無料ホスティング）のみで本番運用できるように設計されています。

---

## 📁 収録ファイル一覧

```
.
├── index.html                      # 生産管理システム 本体（全15業務タブ完備）
├── sync.js                         # 同時編集・差分同期・権限判定・ログイン・社員管理
├── firebase-config.js              # Firebase接続設定（本番用）
├── firestore.rules                 # Cloud Firestore セキュリティルール（2ロール・細粒度権限）
├── firebase-blueprint.json         # スキーマ定義ブループリント
├── README.md                       # 本説明書
├── .github/
│   └── workflows/
│       ├── deploy-pages.yml        # GitHub Pages 自動デプロイ ワークフロー
│       └── daily-backup.yml        # 毎日深夜の自動バックアップ ワークフロー
├── scripts/
│   ├── manage-staff.js             # 初期管理者登録・PWリセット CLIスクリプト
│   └── cloud-backup.js             # Firestore全データ自動バックアップスクリプト
├── tests/
│   └── security-rules.test.ts      # セキュリティルール ユニットテスト仕様書
└── docs/
    ├── manual.md                   # 構築・運用手順書（Firebase・権限設定・バックアップ）
    └── design.md                   # システム設計書（データ構造・クォータ防御・3-wayマージ）
```

---

## ⚡ テストモードですぐに試す方法

本システムは設定不要の「テスト（モック）モード」を内蔵しています。
ブラウザで `index.html` を開くだけですぐに全画面・全機能をお試しいただけます。

- **初期管理者アカウント**:
  - 社員ID: `admin`
  - パスワード: `admin12345`
- **一般社員アカウント（テスト用）**:
  - 社員ID: `yamada`
  - パスワード: `worker12345`

---

## 🚀 本番公開の手順（完全無料）

1. **Firebaseの準備**:
   - [Firebase Console](https://console.firebase.google.com/) で新規プロジェクト作成。
   - Authentication（メール/パスワード）と Firestore Database（東京リージョン `asia-northeast1`）を有効化。
   - `firestore.rules` を貼り付けて公開。
2. **設定の反映**:
   - Firebaseコンソールの「プロジェクトの設定」からWebアプリ設定値（apiKey, projectId等）をコピー。
   - `firebase-config.js` の `mode: 'firestore'` に切り替え、各設定値を貼り付け。
3. **GitHubへのアップロード**:
   - GitHubでPublicリポジトリを作成し、本一式をプッシュ。
   - リポジトリの Settings > Pages で Source を **「GitHub Actions」** に選択。
   - 数分で全世界から高速アクセス可能なWebシステムが公開されます。

詳細な手順については `docs/manual.md` をご参照ください。
