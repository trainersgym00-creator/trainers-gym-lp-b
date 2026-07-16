// ============================================================
// freee OAuth初回認可ヘルパー（ローカルで1回だけ実行する）
// 使い方:
//   FREEE_CLIENT_ID=xxx FREEE_CLIENT_SECRET=yyy node freee-get-token.js
// ============================================================
const fs = require('fs');
const readline = require('readline');

const CLIENT_ID = process.env.FREEE_CLIENT_ID;
const CLIENT_SECRET = process.env.FREEE_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const AUTH_BASE = 'https://accounts.secure.freee.co.jp/public_api';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ FREEE_CLIENT_ID / FREEE_CLIENT_SECRET を環境変数で指定してください。');
  console.error('   例: FREEE_CLIENT_ID=xxx FREEE_CLIENT_SECRET=yyy node freee-get-token.js');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

(async () => {
  const authUrl = `${AUTH_BASE}/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&prompt=select_company`;
  console.log('\n1️⃣ 以下のURLをブラウザで開き、freeeにログインして連携を許可してください:\n');
  console.log(`   ${authUrl}\n`);

  const code = (await ask('2️⃣ 画面に表示された認可コードを貼り付けてEnter: ')).trim();

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    console.error(`❌ トークン取得失敗 (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const token = await res.json();

  // 事業所IDを取得して表示
  const companiesRes = await fetch('https://api.freee.co.jp/api/1/companies', {
    headers: { 'Authorization': `Bearer ${token.access_token}` },
  });
  const companies = companiesRes.ok ? (await companiesRes.json()).companies : [];

  fs.writeFileSync('freee-tokens.json', JSON.stringify({
    refresh_token: token.refresh_token,
    saved_at: new Date().toISOString(),
  }, null, 2));

  console.log('\n✅ トークン取得成功！ freee-tokens.json に保存しました（このファイルはコミットしないこと）\n');
  console.log('3️⃣ GitHubリポジトリの Settings → Secrets and variables → Actions に以下を登録してください:\n');
  console.log(`   FREEE_CLIENT_ID     = ${CLIENT_ID}`);
  console.log(`   FREEE_CLIENT_SECRET = （アプリの Client Secret）`);
  console.log(`   FREEE_REFRESH_TOKEN = ${token.refresh_token}`);
  if (companies.length) {
    console.log(`   FREEE_COMPANY_ID    = ${companies[0].id}  （事業所: ${companies[0].display_name || companies[0].name}）`);
    if (companies.length > 1) {
      console.log('\n   ※ 複数の事業所があります。対象の事業所IDを選んでください:');
      companies.forEach(c => console.log(`      ${c.id}: ${c.display_name || c.name}`));
    }
  } else {
    console.log('   FREEE_COMPANY_ID    = （freeeの事業所ID）');
  }
  console.log('\n⚠️ 注意: リフレッシュトークンは1回使うと新しいものに入れ替わります。');
  console.log('   GitHub Actionsでの初回実行後は、Secretsが自動で更新されます。');
  rl.close();
})();
