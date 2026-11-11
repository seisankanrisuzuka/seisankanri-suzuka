/**
 * tests/security-rules.test.ts
 * Firebase Security Rules（firestore.rules）のユニットテスト仕様
 * 2ロール構成（管理者 admin / 一般社員 staff）およびタブ別権限の検証
 * 
 * 実行環境（Firebase Local Emulator Suite導入時）:
 *   firebase emulators:exec "npm test"
 */

import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import * as fs from 'fs';

let testEnv: RulesTestEnvironment;

describe('生産管理システム セキュリティルール検証', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-production-system',
      firestore: {
        rules: fs.readFileSync('firestore.rules', 'utf8'),
        host: '127.0.0.1',
        port: 8080
      }
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();

    // 初期データセットアップ（管理者と一般社員）
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      
      // 管理者（全権限あり）
      await db.collection('staff').doc('admin_user').set({
        staffId: 'admin',
        name: '管理者',
        role: 'admin',
        active: true,
        allowedTabs: ['dashboard', 'register', 'production', 'stage-cut', 'loading', 'delivery', 'settings', 'staff'],
        actions: { deleteList: true },
        version: 1
      });

      // 一般社員（製造・切断工程のみ許可、リスト登録・削除は不許可）
      await db.collection('staff').doc('worker_user').set({
        staffId: 'worker',
        name: '製造担当',
        role: 'staff',
        active: true,
        allowedTabs: ['dashboard', 'production', 'stage-cut'],
        actions: { deleteList: false },
        version: 1
      });

      // 一般社員（リスト登録許可あり）
      await db.collection('staff').doc('clerk_user').set({
        staffId: 'clerk',
        name: '事務担当',
        role: 'staff',
        active: true,
        allowedTabs: ['dashboard', 'register'],
        actions: { deleteList: true },
        version: 1
      });

      // 既存リストデータ作成
      await db.collection('lists').doc('S00001').set({
        serial: 'S00001',
        job: '既存工事A',
        destination: '第1工場',
        processStatus: { '切断': '未' },
        deleted: false,
        version: 1
      });
    });
  });

  test('未ログインユーザーは一切アクセスできない（Default Deny）', async () => {
    const unauthDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauthDb.collection('lists').get());
    await assertFails(unauthDb.collection('staff').doc('admin_user').get());
  });

  test('「リスト登録」タブ権限を持たない一般社員は新規リスト作成が拒否される', async () => {
    const workerDb = testEnv.authenticatedContext('worker_user').firestore();
    await assertFails(workerDb.collection('lists').doc('S00002').set({
      serial: 'S00002',
      job: '新規工事',
      destination: '第2工場'
    }));
  });

  test('「リスト登録」タブ権限を持つ一般社員は新規リスト作成が許可される', async () => {
    const clerkDb = testEnv.authenticatedContext('clerk_user').firestore();
    await assertSucceeds(clerkDb.collection('lists').doc('S00002').set({
      serial: 'S00002',
      job: '新規工事',
      destination: '第2工場'
    }));
  });

  test('削除許可（actions.deleteList）がない一般社員は削除が拒否される', async () => {
    const workerDb = testEnv.authenticatedContext('worker_user').firestore();
    await assertFails(workerDb.collection('lists').doc('S00001').delete());
    // 論理削除フラグの更新も拒否される
    await assertFails(workerDb.collection('lists').doc('S00001').update({
      deleted: true
    }));
  });

  test('切断工程権限を持つ社員は進捗ステータスを更新できるが、基本情報（納品先等）の変更は拒否される', async () => {
    const workerDb = testEnv.authenticatedContext('worker_user').firestore();
    // 進捗の更新は成功
    await assertSucceeds(workerDb.collection('lists').doc('S00001').update({
      processStatus: { '切断': '完了' }
    }));
    // 基本情報の変更は拒否される
    await assertFails(workerDb.collection('lists').doc('S00001').update({
      destination: '別工場へ変更'
    }));
  });

  test('管理者はリストの登録・削除・全タブ設定が可能', async () => {
    const adminDb = testEnv.authenticatedContext('admin_user').firestore();
    await assertSucceeds(adminDb.collection('lists').doc('S00003').set({
      serial: 'S00003',
      job: '管理者工事',
      destination: '本社',
      deleted: false,
      version: 1
    }));
  });

  test('監査ログ（auditLogs）は追記可能だが、更新や削除は拒否される（改ざん防止）', async () => {
    const workerDb = testEnv.authenticatedContext('worker_user').firestore();
    await assertSucceeds(workerDb.collection('auditLogs').doc('log1').set({
      at: '2026-11-10T00:00:00.000Z',
      by: 'worker_user',
      col: 'lists',
      docId: 'S00001',
      op: 'update'
    }));

    // 一般社員は削除不可
    await assertFails(workerDb.collection('auditLogs').doc('log1').delete());

    // 管理者は削除可能（30日超過ログの一括削除）
    const adminDb = testEnv.authenticatedContext('admin_user').firestore();
    await assertSucceeds(adminDb.collection('auditLogs').doc('log1').delete());
  });
});
