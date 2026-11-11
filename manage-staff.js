/**
 * scripts/manage-staff.js
 * 管理者用コマンドラインスクリプト（Cloud Functions不使用・無料プラン対応）
 * 
 * 使い方:
 *   # 初期管理者の作成 / 登録
 *   node scripts/manage-staff.js init-admin <staffId> <displayName> <password>
 * 
 *   # パスワードリセット（管理者が強制再発行）
 *   node scripts/manage-staff.js reset-pw <staffId> <newPassword>
 * 
 *   # アカウント停止（ログイン無効化）
 *   node scripts/manage-staff.js disable <staffId>
 * 
 *   # アカウント有効化
 *   node scripts/manage-staff.js enable <staffId>
 * 
 * 必要環境変数:
 *   FIREBASE_SERVICE_ACCOUNT (サービスアカウントJSONファイルパスまたはJSON文字列)
 */

const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
生産管理システム 社員管理CLI（管理者用）
------------------------------------------
コマンド一覧:
  node scripts/manage-staff.js init-admin <staffId> <name> <password>
  node scripts/manage-staff.js reset-pw <staffId> <newPassword>
  node scripts/manage-staff.js disable <staffId>
  node scripts/manage-staff.js enable <staffId>
`);
    return;
  }

  const saEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saEnv) {
    console.error('エラー: 環境変数 FIREBASE_SERVICE_ACCOUNT が設定されていません。');
    process.exit(1);
  }

  let serviceAccount;
  if (fs.existsSync(saEnv)) {
    serviceAccount = JSON.parse(fs.readFileSync(saEnv, 'utf8'));
  } else {
    serviceAccount = JSON.parse(saEnv);
  }

  const admin = require('firebase-admin');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const auth = admin.auth();
  const db = admin.firestore();

  const domain = process.env.STAFF_DOMAIN || 'seisankanri-suzuka-aa08c.firebaseapp.com';
  const toEmail = id => `${id.trim().toLowerCase()}@${domain}`;

  if (command === 'init-admin') {
    const [_, id, name, pw] = args;
    if (!id || !name || !pw) {
      console.error('引数が足りません: init-admin <staffId> <name> <password>');
      return;
    }
    const email = toEmail(id);
    let user;
    try {
      user = await auth.getUserByEmail(email);
      console.log(`既存ユーザーが見つかりました: ${user.uid} (${email})`);
      await auth.updateUser(user.uid, { password: pw, disabled: false });
    } catch (e) {
      user = await auth.createUser({ email, password: pw, displayName: name });
      console.log(`新規Authユーザーを作成しました: ${user.uid}`);
    }

    const allTabs = ['dashboard', 'register', 'production', 'stage-cut', 'stage-bandsaw', 'stage-kiri', 'stage-shot', 'stage-bevel', 'stage-bend', 'loading', 'delivery', 'delivery-search', 'plan', 'report', 'settings', 'staff'];
    await db.collection('staff').doc(user.uid).set({
      staffId: id.toLowerCase(),
      name: name,
      role: 'admin',
      active: true,
      allowedTabs: allTabs,
      actions: { deleteList: true },
      mustChangePassword: false,
      version: 1,
      createdAt: new Date().toISOString(),
      createdBy: 'cli',
      updatedAt: new Date().toISOString(),
      updatedBy: 'cli'
    }, { merge: true });

    console.log(`✅ 管理者「${id}」(${name}) を作成・設定しました。初期パスワードでログイン可能です。`);
  }

  else if (command === 'reset-pw') {
    const [_, id, newPw] = args;
    if (!id || !newPw) {
      console.error('引数が足りません: reset-pw <staffId> <newPassword>');
      return;
    }
    const email = toEmail(id);
    const user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password: newPw });
    await db.collection('staff').doc(user.uid).update({
      mustChangePassword: true,
      updatedAt: new Date().toISOString(),
      updatedBy: 'cli-admin'
    });
    console.log(`✅ 社員「${id}」のパスワードをリセットしました（次回ログイン時に変更が求められます）。`);
  }

  else if (command === 'disable') {
    const [_, id] = args;
    const email = toEmail(id);
    const user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { disabled: true });
    await db.collection('staff').doc(user.uid).update({
      active: false,
      updatedAt: new Date().toISOString(),
      updatedBy: 'cli-admin'
    });
    console.log(`🚫 社員「${id}」のアカウントを無効化しました。`);
  }

  else if (command === 'enable') {
    const [_, id] = args;
    const email = toEmail(id);
    const user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { disabled: false });
    await db.collection('staff').doc(user.uid).update({
      active: true,
      updatedAt: new Date().toISOString(),
      updatedBy: 'cli-admin'
    });
    console.log(`✅ 社員「${id}」のアカウントを再有効化しました。`);
  }
}

main().catch(err => {
  console.error('実行時エラー:', err);
  process.exit(1);
});
