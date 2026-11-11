const fs = require('fs');

let html = fs.readFileSync('public/assets/aistudio/production_management_system__1__d8338eac.html', 'utf8');

// 1. In head, add firebase-config.js and sync.js scripts
const headInject = '  <script src="firebase-config.js"></script>\n  <script src="sync.js"></script>\n</head>';
html = html.replace('</head>', headInject);

// 2. In nav, add 社員管理 button after データ管理
const navTarget = '<button data-page="settings">データ管理</button>';
const navReplace = '<button data-page="settings">データ管理</button>\n<button data-page="staff" class="admin-only">社員管理</button>';
html = html.replace(navTarget, navReplace);

// 3. In main, add staff section after settings
const settingsEnd = '</section>\n\n<div id="editListModal"';
const staffSection = '</section>\n<section id="staff" class="page admin-only">\n<div id="staffBody"></div>\n</section>\n\n<div id="editListModal"';
html = html.replace(settingsEnd, staffSection);

// 4. In settings page, add audit log management panel and update purge days default to 90
const oldPurgePanel = '<div class="panel"><h2>古いデータの削除</h2><p class="help">積み込みが全部完了してから指定した日数がたったリストを削除します。削除の前に、バックアップのJSONを自動で書き出します。（積み込みが完了した翌日以降のリストは、削除しなくても通常の画面には出ません。）</p><div class="row"><div class="field"><label>積み込み完了から（日以上）</label><input id="purgeDays" type="number" min="1" step="1" value="30"></div></div><div id="purgeCount" class="help" style="margin:6px 0"></div><button class="btn danger" type="button" id="purgeBtn">古いデータを削除</button><div id="purgeMsg" class="help" style="margin-top:8px"></div></div>';

const newPurgePanel = `<div class="panel admin-only" id="auditPanel">
  <h2>操作履歴（監査ログ）の管理</h2>
  <p class="help">無料枠（Sparkプラン）を優先するため、30日を超えた操作履歴の定期的な一括削除を行えます。</p>
  <label class="inline-check" style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:13px">
    <input type="checkbox" id="auditToggleCheck" checked>
    <b>操作履歴（監査ログ）を記録する</b>（オフにすると書き込み回数を節約できます）
  </label>
  <div style="margin-top:10px">
    <button class="btn danger small" type="button" id="purgeAuditBtn">30日以上前の操作履歴を一括削除</button>
    <span id="auditPurgeMsg" class="help" style="margin-left:8px"></span>
  </div>
</div>
<div class="panel">
  <h2>完了案件の削除（90日経過後・管理者専用）</h2>
  <p class="help">全工程・積み込みが完了してから指定した日数が経過したリストを削除します。削除前に対象一覧の確認およびJSONバックアップが可能です。（未完了案件や完了日のない案件は絶対に削除されません。）</p>
  <div class="row"><div class="field"><label>完了から経過日数（日以上）</label><input id="purgeDays" type="number" min="1" step="1" value="90"></div></div>
  <div id="purgeCount" class="help" style="margin:6px 0"></div>
  <button class="btn danger" type="button" id="purgeBtn">完了案件の削除を確認</button>
  <div id="purgeMsg" class="help" style="margin-top:8px"></div>
</div>`;

html = html.replace(oldPurgePanel, newPurgePanel);

// 5. In script, fix duplicate renderAll declaration:
html = html.replace('function renderAll(){renderStats();renderDash();renderRegister();renderProd();renderLoad();renderPlan()}', '// (Initial renderAll replaced)');

// 6. Replace serial(processes) implementation to support async nextSerial:
const oldSerialFn = `function serial(processes=[]){let reg={next:1,issued:[],retired:[]};try{reg={...reg,...JSON.parse(localStorage.getItem(SERIAL_KEY)||"{}")}}catch(e){};reg.issued=Array.isArray(reg.issued)?reg.issued.map(String):[];reg.retired=Array.isArray(reg.retired)?reg.retired.map(String):[];reg.next=Math.max(1,parseInt(reg.next,10)||1);
 /* 工程番号は「S＋5桁」（S00001〜S99999）。順番に発行し、S99999まで使い切ったらS00001に戻る。戻ったあとは「いま登録されているリストが使っていない番号」だけを再利用する */
 let s,tries=0;do{if(reg.next>99999){reg.next=1;reg.issued=[];reg.retired=[]}s="S"+String(reg.next++).padStart(5,"0");if(++tries>100000)throw new Error("工程番号の空きがありません")}while(reg.issued.includes(s)||reg.retired.includes(s)||lists.some(x=>String(x.serial)===s));reg.issued.push(s);localStorage.setItem(SERIAL_KEY,JSON.stringify(reg));return s}`;

const newSerialFn = `async function serialAsync(processes=[]){
  if(window.Sync&&window.Sync.on&&window.Sync.nextSerial){
    try {
      return await window.Sync.nextSerial();
    } catch(e) {
      console.warn("Sync nextSerial failed, falling back to local:", e);
    }
  }
  return serial(processes);
}
function serial(processes=[]){let reg={next:1,issued:[],retired:[]};try{reg={...reg,...JSON.parse(localStorage.getItem(SERIAL_KEY)||"{}")}}catch(e){};reg.issued=Array.isArray(reg.issued)?reg.issued.map(String):[];reg.retired=Array.isArray(reg.retired)?reg.retired.map(String):[];reg.next=Math.max(1,parseInt(reg.next,10)||1);
 let s,tries=0;do{if(reg.next>99999){reg.next=1;reg.issued=[];reg.retired=[]}s="S"+String(reg.next++).padStart(5,"0");if(++tries>100000)throw new Error("工程番号の空きがありません")}while(reg.issued.includes(s)||reg.retired.includes(s)||lists.some(x=>String(x.serial)===s));reg.issued.push(s);localStorage.setItem(SERIAL_KEY,JSON.stringify(reg));return s}`;

html = html.replace(oldSerialFn, newSerialFn);

// 7. Replace save(), persistDelivery(), persistStageBoard(), persistCutSpeeds() to trigger Sync
const oldSaveFn = 'function save(){lists.forEach(ensureOutsourcedPile);localStorage.setItem(KEY,JSON.stringify(lists));renderAll();try{updateExportCsvCount();updatePurgeCount()}catch(e){}}';
const newSaveFn = `function save(){
  lists.forEach(ensureOutsourcedPile);
  localStorage.setItem(KEY,JSON.stringify(lists));
  renderAll();
  try{updateExportCsvCount();updatePurgeCount()}catch(e){}
  if(window.Sync&&window.Sync.on&&window.Sync.pushLists){
    window.Sync.pushLists();
  }
}`;
html = html.replace(oldSaveFn, newSaveFn);

const oldPersistDelivery = 'function persistDelivery(){localStorage.setItem(DELIVERY_BOARD_KEY,JSON.stringify(deliveryBoard));localStorage.setItem(EVENT_KEY,JSON.stringify(deliveryEvents));localStorage.setItem(DELIVERY_META_KEY,JSON.stringify(deliveryMeta))}';
const newPersistDelivery = `function persistDelivery(){
  localStorage.setItem(DELIVERY_BOARD_KEY,JSON.stringify(deliveryBoard));
  localStorage.setItem(EVENT_KEY,JSON.stringify(deliveryEvents));
  localStorage.setItem(DELIVERY_META_KEY,JSON.stringify(deliveryMeta));
  if(window.Sync&&window.Sync.on&&window.Sync.pushDelivery){
    window.Sync.pushDelivery();
  }
}`;
html = html.replace(oldPersistDelivery, newPersistDelivery);

const oldPersistStage = 'function persistStageBoard(){localStorage.setItem(STAGE_ORDER_KEY,JSON.stringify(stageBoard))}';
const newPersistStage = `function persistStageBoard(){
  localStorage.setItem(STAGE_ORDER_KEY,JSON.stringify(stageBoard));
  if(window.Sync&&window.Sync.on&&window.Sync.pushStage){
    window.Sync.pushStage();
  }
}`;
html = html.replace(oldPersistStage, newPersistStage);

const oldPersistCut = 'function persistCutSpeeds(){try{localStorage.setItem(CUT_SPEED_KEY,JSON.stringify(cutSpeeds))}catch(e){}}';
const newPersistCut = `function persistCutSpeeds(){
  try{localStorage.setItem(CUT_SPEED_KEY,JSON.stringify(cutSpeeds))}catch(e){}
  if(window.Sync&&window.Sync.on&&window.Sync.pushSettings){
    window.Sync.pushSettings();
  }
}`;
html = html.replace(oldPersistCut, newPersistCut);

// 8. Update CSV import and manual list save to use async serialAsync
html = html.replace('let serialVal=existing?existing.serial:serial(processesRaw);', 'let serialVal=existing?existing.serial:(await serialAsync(processesRaw));');
html = html.replace('$("importCsvBtn").onclick=()=>{', '$("importCsvBtn").onclick=async()=>{');

html = html.replace('const serialVal=serial(processes);', 'const serialVal=await serialAsync(processes);');
html = html.replace("$('saveManualListBtn').addEventListener('click',()=>{", "$('saveManualListBtn').addEventListener('click',async()=>{");

// 9. Update exportBtn and importBackupText to use Sync when enabled
const oldExportClick = '$("exportBtn").onclick=()=>{downloadBackup("factory-link-backup.json");$("backupMsg").textContent="バックアップファイルを書き出しました。"};';
const newExportClick = `$("exportBtn").onclick=async()=>{
  if(window.Sync&&window.Sync.on&&window.Sync.exportAll&&window.Sync.isAdmin&&window.Sync.isAdmin()){
    try{
      const data=await window.Sync.exportAll();
      const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),a=document.createElement("a");
      a.href=URL.createObjectURL(blob);a.download="factory-link-backup-"+todayStr()+".json";
      document.body.appendChild(a);a.click();
      setTimeout(()=>{a.remove();URL.revokeObjectURL(a.href)},1500);
      $("backupMsg").textContent="クラウド（Firestore）から全バックアップファイルを書き出しました。";
      return;
    }catch(err){
      $("backupMsg").textContent="クラウドバックアップの書き出しに失敗しました："+(err&&err.message||err);
      return;
    }
  }
  downloadBackup("factory-link-backup.json");$("backupMsg").textContent="バックアップファイルを書き出しました。";
};`;
html = html.replace(oldExportClick, newExportClick);

const oldImportConfirm = 'if(confirm(`現在のデータをバックアップ内容（${data.length}件）で置き換えますか？`)){';
const newImportConfirm = `if(confirm(\`現在のデータをバックアップ内容（\${data.length}件）で置き換えますか？\`)){
    if(window.Sync&&window.Sync.on&&window.Sync.restore&&window.Sync.isAdmin&&window.Sync.isAdmin()){
      try{
        msg.textContent="クラウド（Firestore）へ復元中...";
        const n=await window.Sync.restore(extra||{lists:data});
        msg.textContent=\`クラウドへの復元が完了しました（\${n}件）。\`;
        return;
      }catch(err){
        msg.textContent="クラウドへの復元に失敗しました："+(err&&err.message||err);
        return;
      }
    }`;
html = html.replace(oldImportConfirm, newImportConfirm);

// 10. Update purgeTargets and purgeBtn (Requirement 6: 90 days, admin only, target preview modal, JSON backup)
const oldPurgeLogic = `function purgeTargets(){const n=Math.max(1,parseInt($("purgeDays").value,10)||30);const d=new Date();d.setDate(d.getDate()-n);const lim=\`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,"0")}-\${String(d.getDate()).padStart(2,"0")}\`;return lists.filter(l=>{const c=loadCompleteDay(l);return c!==null&&c<todayStr()&&c<=lim})}
function updatePurgeCount(){try{$("purgeCount").textContent=\`削除対象：\${purgeTargets().length}件 / 全\${lists.length}件\`}catch(e){}}
$("purgeDays").addEventListener("input",updatePurgeCount);updatePurgeCount();
$("purgeBtn").onclick=()=>{const t=purgeTargets();if(!t.length){$("purgeMsg").textContent="削除対象のリストはありません。";return}
 if(!confirm(\`積み込み完了から\${Math.max(1,parseInt($("purgeDays").value,10)||30)}日以上たったリスト \${t.length}件を削除します。\\n\\n「OK」を押すと、削除の前にバックアップのJSONファイルを自動で書き出します。\\n「キャンセル」を押すと、何も削除しません。\`)){$("purgeMsg").textContent="キャンセルしました。データは削除していません。";return}
 const d=new Date(),p2=n=>String(n).padStart(2,"0"),fname=\`factory-link-backup-before-purge-\${d.getFullYear()}\${p2(d.getMonth()+1)}\${p2(d.getDate())}-\${p2(d.getHours())}\${p2(d.getMinutes())}.json\`;
 try{downloadBackup(fname)}catch(err){$("purgeMsg").textContent="バックアップの書き出しに失敗したため、削除を中止しました。";return}
 setTimeout(()=>{const ids=new Set(t.map(l=>String(l.serial)));lists=lists.filter(l=>!ids.has(String(l.serial)));deliveryBoard=deliveryBoard.filter(x=>!(x&&typeof x.key==="string"&&x.key.startsWith("L:")&&ids.has(x.key.slice(2))));ids.forEach(id=>{delete deliveryMeta["L:"+id]});persistDelivery();save();updatePurgeCount();$("purgeMsg").textContent=\`\${t.length}件を削除しました。削除前のバックアップを「\${fname}」として書き出しています。\`},700)};`;

const newPurgeLogic = `function purgeTargets(){
  const n = Math.max(1, parseInt($("purgeDays").value, 10) || 90);
  const d = new Date(); d.setDate(d.getDate() - n);
  const lim = \`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,"0")}-\${String(d.getDate()).padStart(2,"0")}\`;
  return lists.filter(l => {
    // 未完了案件は絶対に削除対象にしない（納期未定なども保護）
    if(l.isOpen !== false) return false;
    const c = l.closedDay || (typeof loadCompleteDay === 'function' ? loadCompleteDay(l) : null);
    // 完了日が記録されていない案件は削除対象外
    if(!c) return false;
    return c <= lim;
  });
}
function updatePurgeCount(){
  try{ $("purgeCount").textContent = \`削除対象（90日以上経過の完了案件）：\${purgeTargets().length}件 / 全\${lists.length}件\`; }catch(e){}
}
$("purgeDays").addEventListener("input", updatePurgeCount);
updatePurgeCount();

// 操作履歴（監査ログ）パネルの制御
setTimeout(()=>{
  const aChk = $("auditToggleCheck");
  if(aChk){
    aChk.checked = window.Sync ? window.Sync.isAuditEnabled() : true;
    aChk.onchange = () => {
      if(window.Sync && window.Sync.setAuditEnabled){
        window.Sync.setAuditEnabled(aChk.checked);
        $("auditPurgeMsg").textContent = aChk.checked ? "操作履歴の記録を有効化しました。" : "操作履歴の記録を停止しました（無料枠節約）。";
      }
    };
  }
  const aBtn = $("purgeAuditBtn");
  if(aBtn){
    aBtn.onclick = async () => {
      if(window.Sync && window.Sync.purgeOldAuditLogs){
        try{
          const cnt = await window.Sync.purgeOldAuditLogs();
          $("auditPurgeMsg").textContent = cnt > 0 ? \`\${cnt} 件の古い操作履歴を削除しました。\` : "削除対象はありませんでした。";
        }catch(e){
          $("auditPurgeMsg").textContent = "削除失敗: " + (e.message || e);
        }
      }
    };
  }
}, 500);

$("purgeBtn").onclick = async () => {
  if(window.Sync && window.Sync.isAdmin && !window.Sync.isAdmin()){
    alert("完了案件の削除は管理者のみ実行できます。");
    return;
  }
  const t = purgeTargets();
  if(!t.length){
    $("purgeMsg").textContent = "90日以上経過した削除対象の完了案件はありません。";
    return;
  }

  // 削除前に対象一覧と件数を表示する確認ダイアログ
  let modal = document.getElementById("purgeModal");
  if(!modal){
    modal = document.createElement("div");
    modal.id = "purgeModal";
    modal.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,.8);backdrop-filter:blur(3px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box";
    document.body.appendChild(modal);
  }
  const rows = t.slice(0, 30).map(l => {
    const c = l.closedDay || (typeof loadCompleteDay === 'function' ? loadCompleteDay(l) : '-');
    return \`<tr><td style="padding:6px;border-bottom:1px solid #e2e8f0;font-weight:700">\${esc(l.serial)}</td><td style="padding:6px;border-bottom:1px solid #e2e8f0">\${esc(l.job||'')}</td><td style="padding:6px;border-bottom:1px solid #e2e8f0">\${esc(l.customer||'')}</td><td style="padding:6px;border-bottom:1px solid #e2e8f0">\${esc(c)}</td></tr>\`;
  }).join('');

  modal.innerHTML = \`
    <div style="background:#fff;border-radius:14px;padding:24px;width:min(94vw,620px);max-height:85vh;overflow-y:auto;box-shadow:0 20px 45px rgba(0,0,0,.3);box-sizing:border-box">
      <h3 style="margin:0 0 8px;font-size:18px;color:#991b1b">⚠️ 完了案件の削除（最終確認）</h3>
      <p style="margin:0 0 12px;font-size:13px;color:#475569">
        完了から \${Math.max(1,parseInt($("purgeDays").value,10)||90)} 日以上経過した完了案件 <b>\${t.length}件</b> を削除します。<br>
        ※ 未完了案件や完了日のない案件は厳格に除外されています。
      </p>
      <div style="max-height:200px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:14px">
        <table style="width:100%;border-collapse:collapse;font-size:12px;text-align:left">
          <thead><tr style="background:#f8fafc"><th style="padding:6px;border-bottom:1px solid #e2e8f0">工程番号</th><th style="padding:6px;border-bottom:1px solid #e2e8f0">工事名</th><th style="padding:6px;border-bottom:1px solid #e2e8f0">需要家</th><th style="padding:6px;border-bottom:1px solid #e2e8f0">完了日</th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>
      </div>
      \${t.length > 30 ? \`<div style="font-size:11px;color:#64748b;margin-bottom:10px">（ほか \${t.length - 30} 件）</div>\` : ''}
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="purgeDownloadBackupBtn" type="button" style="padding:10px;font-size:13px;font-weight:700;background:#059669;color:#fff;border:0;border-radius:8px;cursor:pointer">
          💾 削除前に対象案件のバックアップJSONをダウンロード
        </button>
        <button id="purgeExecBtn" type="button" style="padding:10px;font-size:13px;font-weight:700;background:#dc2626;color:#fff;border:0;border-radius:8px;cursor:pointer">
          🗑️ 上記 \${t.length} 件を完全に削除する
        </button>
        <button id="purgeCancelBtn" type="button" style="padding:8px;font-size:12px;color:#64748b;background:none;border:0;cursor:pointer;text-decoration:underline">
          キャンセル
        </button>
      </div>
    </div>
  \`;
  modal.style.display = "flex";

  document.getElementById("purgeDownloadBackupBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(t, null, 2)], { type: "application/json" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = \`completed-orders-backup-\${todayStr()}.json\`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 1500);
  };

  document.getElementById("purgeExecBtn").onclick = async () => {
    if(!confirm(\`本当に \${t.length} 件の完了案件を削除しますか？\\nこの操作は取り消せません。\`)) return;
    modal.style.display = "none";
    $("purgeMsg").textContent = "クラウドおよびローカルから削除中...";
    if(window.Sync && window.Sync.purgeCompletedLists){
      try{
        const cnt = await window.Sync.purgeCompletedLists(t.map(l => l.serial));
        $("purgeMsg").textContent = \`\${cnt} 件の完了案件を削除しました。\`;
        updatePurgeCount();
      }catch(e){
        $("purgeMsg").textContent = "削除中にエラーが発生しました：" + (e.message || e);
      }
    } else {
      const ids = new Set(t.map(l => String(l.serial)));
      lists = lists.filter(l => !ids.has(String(l.serial)));
      persistDelivery(); save(); updatePurgeCount();
      $("purgeMsg").textContent = \`\${t.length} 件を削除しました。\`;
    }
  };

  document.getElementById("purgeCancelBtn").onclick = () => {
    modal.style.display = "none";
    $("purgeMsg").textContent = "キャンセルしました。";
  };
};`;

html = html.replace(oldPurgeLogic, newPurgeLogic);

// 11. Fix sort writes & tab click notifications
html = html.replace('localStorage.setItem(STAGE_ORDER_KEY,JSON.stringify(stageBoard));board=stageBoard[key];', '// Read-only view sorting without triggering unintended writes\nboard=stageAutoSort(process,board);');
html = html.replace('deliveryBoard=deliveryAutoSort(deliveryBoard,byKey);persistDelivery();return deliveryBoard', 'deliveryBoard=deliveryAutoSort(deliveryBoard,byKey);return deliveryBoard');

const oldNavClick = 'document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{';
const newNavClick = `document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{
  if(window.Sync && window.Sync.switchTab){
    window.Sync.switchTab(b.dataset.page);
  }`;
html = html.replace(oldNavClick, newNavClick);

// 12. Boot sync bridge at the end of the script:
const bootSnippet = `
// ===== Sync Bridge 初期化 =====
if(window.Sync&&window.Sync.boot){
  let renderTimer=null;
  const bridge={
    getLists:()=>lists,
    setLists:ls=>{lists=ls;localStorage.setItem(KEY,JSON.stringify(lists))},
    getEvents:()=>deliveryEvents,
    setEvents:evs=>{deliveryEvents=evs;localStorage.setItem(EVENT_KEY,JSON.stringify(deliveryEvents))},
    getMeta:()=>deliveryMeta,
    setMeta:m=>{deliveryMeta=m;localStorage.setItem(DELIVERY_META_KEY,JSON.stringify(deliveryMeta))},
    getStageBoard:()=>stageBoard,
    setStageBoard:sb=>{stageBoard=sb;localStorage.setItem(STAGE_ORDER_KEY,JSON.stringify(stageBoard))},
    getDeliveryBoard:()=>deliveryBoard,
    setDeliveryBoard:db=>{deliveryBoard=db;localStorage.setItem(DELIVERY_BOARD_KEY,JSON.stringify(deliveryBoard))},
    getCutSpeeds:()=>cutSpeeds,
    setCutSpeeds:cs=>{cutSpeeds=cs;localStorage.setItem(CUT_SPEED_KEY,JSON.stringify(cutSpeeds))},
    loadCompleteDay:loadCompleteDay,
    normalize:normalizeListData,
    ensure:ensureOutsourcedPile,
    renderSoon:()=>{
      if(renderTimer)clearTimeout(renderTimer);
      renderTimer=setTimeout(()=>{renderAll();renderTimer=null},40);
    }
  };
  window.Sync.boot(bridge);
}
`;

html = html.replace('processUI();renderAll();\n</script>', 'processUI();renderAll();\n' + bootSnippet + '</script>');

fs.writeFileSync('public/index.html', html);
console.log('Successfully generated public/index.html, length:', html.length);
