// ============================================================
// freee 自動仕訳 かんたんセットアップ
// これ1つで「freee接続 → GitHubへの登録」まで全部やります。
//
// 使い方: node freee-setup.js
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const REPO = 'trainersgym00-creator/trainers-gym-lp-b';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const AUTH_BASE = 'https://accounts.secure.freee.co.jp/public_api';
const TOOLS_DIR = path.join(__dirname, '.tools');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, a => resolve(a.trim())));
const die = (msg) => { console.error(`\n❌ ${msg}\n`); rl.close(); process.exit(1); };

// gh のパス（PATH上のもの、なければダウンロードしたもの）
let GH = 'gh';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// gh が使えるか確認し、無ければ公式バイナリをこのフォルダに落として使う
// （Homebrew も管理者パスワードも不要）
async function ensureGh() {
  for (const candidate of ['gh', path.join(TOOLS_DIR, 'bin', 'gh')]) {
    try { sh(candidate, ['--version']); GH = candidate; return; } catch { /* 次を試す */ }
  }

  console.log('GitHubのコマンド(gh)が無いので、自動でダウンロードします...');
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  const suffix = `macOS_${arch}.zip`;

  // 最新版を探す。取得できない時は動作確認済みのバージョンにフォールバック
  const PINNED = '2.100.0';
  let downloadUrl = null;
  try {
    const relRes = await fetch('https://api.github.com/repos/cli/cli/releases/latest', {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'freee-setup' },
    });
    if (relRes.ok) {
      const asset = (await relRes.json()).assets?.find(a => a.name.endsWith(suffix));
      if (asset) downloadUrl = asset.browser_download_url;
    }
  } catch { /* フォールバックへ */ }
  if (!downloadUrl) {
    downloadUrl = `https://github.com/cli/cli/releases/download/v${PINNED}/gh_${PINNED}_macOS_${arch}.zip`;
  }

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const zipPath = path.join(TOOLS_DIR, 'gh.zip');
  const dl = await fetch(downloadUrl);
  if (!dl.ok) die(`ghのダウンロードに失敗しました (${dl.status})。ネット接続を確認してください。`);
  fs.writeFileSync(zipPath, Buffer.from(await dl.arrayBuffer()));

  sh('unzip', ['-oq', zipPath, '-d', TOOLS_DIR]);
  // 展開先は gh_<version>_macOS_<arch>/bin/gh
  const extracted = fs.readdirSync(TOOLS_DIR).find(d => d.startsWith('gh_') && fs.existsSync(path.join(TOOLS_DIR, d, 'bin', 'gh')));
  if (!extracted) die('ghの展開に失敗しました。');
  const binDir = path.join(TOOLS_DIR, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(TOOLS_DIR, extracted, 'bin', 'gh'), path.join(binDir, 'gh'));
  fs.chmodSync(path.join(binDir, 'gh'), 0o755);
  fs.rmSync(zipPath, { force: true });

  GH = path.join(binDir, 'gh');
  sh(GH, ['--version']); // 動作確認
  console.log('✅ ghの準備ができました\n');
}

(async () => {
  console.log('\n===== freee自動仕訳 セットアップ =====\n');

  // --- 1. GitHubの準備（必要ならghを自動取得＆ログイン）---
  await ensureGh();
  try {
    sh(GH, ['auth', 'status']);
    console.log('✅ GitHubログイン済み\n');
  } catch {
    console.log('--- GitHubへのログインが必要です ---');
    console.log('ブラウザが開くので、表示されるコードを貼り付けて許可してください。\n');
    try {
      execFileSync(GH, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { stdio: 'inherit' });
    } catch {
      die('GitHubへのログインに失敗しました。もう一度 node freee-setup.js を実行してください。');
    }
    try { sh(GH, ['auth', 'status']); } catch { die('GitHubへのログインが完了していません。もう一度実行してください。'); }
    console.log('\n✅ GitHubログイン完了\n');
  }

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
      execFileSync(GH, ['secret', 'set', name, '--repo', REPO, '--body', value], { stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`   ✅ ${name}`);
    } catch (e) {
      die(`${name} の登録に失敗しました。\n   ${e.stderr?.toString() || e.message}`);
    }
  }

  // --- 6. 確認 ---
  const list = sh(GH, ['secret', 'list', '--repo', REPO]);
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
