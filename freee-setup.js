// ============================================================
// freee 自動仕訳 かんたんセットアップ
// これ1つで「freee接続 → GitHubへの登録」まで全部やります。
//
// 使い方: node freee-setup.js
// ============================================================
const fs = require('fs');
const readline = require('readline');
const { execFileSync } = require('child_process');

const REPO = 'trainersgym00-creator/trainers-gym-lp-b';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const AUTH_BASE = 'https://accounts.secure.freee.co.jp/public_api';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, a => resolve(a.trim())));
const die = (msg) => { console.error(`\n❌ ${msg}\n`); rl.close(); process.exit(1); };

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

(async () => {
  console.log('\n===== freee自動仕訳 セットアップ =====\n');

  // --- 1. gh コマンドの確認 ---
  try {
    sh('gh', ['--version']);
  } catch {
    die('GitHubのコマンド(gh)が入っていません。\n   ターミナルで次を実行してから、もう一度やり直してください:\n\n   brew install gh');
  }
  try {
    sh('gh', ['auth', 'status']);
  } catch {
    die('GitHubにログインしていません。\n   ターミナルで次を実行し、ブラウザで許可してから、もう一度やり直してください:\n\n   gh auth login');
  }
  console.log('✅ GitHubの準備OK\n');

  // --- 2. freeeのIDとSecretを入力 ---
  console.log('freeeのアプリ画面に表示されている値を貼り付けてください。\n');
  const clientId = await ask('Client ID を貼り付けてEnter: ');
  if (!clientId) die('Client IDが空です。');
  const clientSecret = await ask('Client Secret を貼り付けてEnter: ');
  if (!clientSecret) die('Client Secretが空です。');

  // --- 3. freee認可 ---
  const authUrl = `${AUTH_BASE}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&prompt=select_company`;
  console.log('\n--- 次に、下のURLをブラウザで開いてfreeeで「許可する」を押してください ---\n');
  console.log(`   ${authUrl}\n`);
  const code = await ask('画面に出た認可コードを貼り付けてEnter: ');
  if (!code) die('認可コードが空です。');

  const tokenRes = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) {
    die(`freeeとの接続に失敗しました (${tokenRes.status})。\n   ${await tokenRes.text()}\n\n   Client ID / Secret / 認可コードのどれかが間違っている可能性があります。`);
  }
  const token = await tokenRes.json();
  console.log('\n✅ freeeとの接続OK\n');

  // --- 4. 事業所を選ぶ ---
  const compRes = await fetch('https://api.freee.co.jp/api/1/companies', {
    headers: { 'Authorization': `Bearer ${token.access_token}` },
  });
  if (!compRes.ok) die(`事業所の取得に失敗しました (${compRes.status})。`);
  const companies = (await compRes.json()).companies || [];
  if (!companies.length) die('事業所が見つかりませんでした。');

  let companyId;
  if (companies.length === 1) {
    companyId = String(companies[0].id);
    console.log(`事業所: ${companies[0].display_name || companies[0].name} (${companyId})\n`);
  } else {
    console.log('対象にする事業所を選んでください:\n');
    companies.forEach((c, i) => console.log(`   ${i + 1}) ${c.display_name || c.name}`));
    const pick = await ask('\n番号を入力してEnter: ');
    const idx = parseInt(pick, 10) - 1;
    if (!(idx >= 0 && idx < companies.length)) die('番号が正しくありません。');
    companyId = String(companies[idx].id);
    console.log(`\n選択: ${companies[idx].display_name || companies[idx].name} (${companyId})\n`);
  }

  // --- 5. GitHubへ登録 ---
  console.log('GitHubに登録しています...\n');
  const secrets = {
    FREEE_CLIENT_ID: clientId,
    FREEE_CLIENT_SECRET: clientSecret,
    FREEE_REFRESH_TOKEN: token.refresh_token,
    FREEE_COMPANY_ID: companyId,
  };
  for (const [name, value] of Object.entries(secrets)) {
    try {
      execFileSync('gh', ['secret', 'set', name, '--repo', REPO, '--body', value], { stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`   ✅ ${name}`);
    } catch (e) {
      die(`${name} の登録に失敗しました。\n   ${e.stderr?.toString() || e.message}`);
    }
  }

  // --- 6. 確認 ---
  const list = sh('gh', ['secret', 'list', '--repo', REPO]);
  const registered = ['FREEE_CLIENT_ID', 'FREEE_CLIENT_SECRET', 'FREEE_REFRESH_TOKEN', 'FREEE_COMPANY_ID']
    .filter(n => new RegExp(`^${n}\\s`, 'm').test(list));

  fs.writeFileSync('freee-tokens.json', JSON.stringify({ refresh_token: token.refresh_token, saved_at: new Date().toISOString() }, null, 2));

  console.log(`\n===== 完了 =====`);
  console.log(`GitHubに登録できたもの: ${registered.length} / 4 件`);
  if (registered.length === 4) {
    console.log('\n🎉 セットアップ完了です！ チャットに「セットアップ完了」と伝えてください。\n');
  } else {
    console.log('\n⚠️ 一部が登録できていません。この画面をチャットに貼って相談してください。\n');
  }
  rl.close();
})().catch(e => {
  console.error(`\n❌ エラー: ${e.message}\n`);
  process.exit(1);
});
