// ============================================================
// freee × Claude 自動仕訳スクリプト
// 銀行・カードの未処理明細(wallet_txns)を取得し、Claudeが
// 勘定科目・税区分を判定して freee に取引(deal)として登録する。
// 使い方: FREEE_SETUP.md を参照
// ============================================================
const fs = require('fs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FREEE_CLIENT_ID = process.env.FREEE_CLIENT_ID;
const FREEE_CLIENT_SECRET = process.env.FREEE_CLIENT_SECRET;
const FREEE_COMPANY_ID = process.env.FREEE_COMPANY_ID;
const PAT_TOKEN = process.env.PAT_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // 例: owner/repo（Actionsが自動設定）

const DRY_RUN = String(process.env.DRY_RUN || 'false') === 'true';
const SYNC_DAYS = parseInt(process.env.FREEE_SYNC_DAYS || '30', 10);   // 何日前までの明細を対象にするか
const MAX_TXNS = parseInt(process.env.FREEE_MAX_TXNS || '50', 10);     // 1回の実行で処理する明細の上限
const MIN_CONFIDENCE = parseFloat(process.env.FREEE_MIN_CONFIDENCE || '0.75'); // これ未満は登録せずレビューへ

const FREEE_API = 'https://api.freee.co.jp';
const TOKEN_ENDPOINT = 'https://accounts.secure.freee.co.jp/public_api/token';
const LOG_PATH = 'freee-journal-log.json';
const LOCAL_TOKEN_PATH = 'freee-tokens.json'; // ローカル実行用（gitignore対象）

// ============================================================
// 1. トークン管理
//    freeeのリフレッシュトークンは1回使うと無効になり新しい
//    ものに入れ替わるため、毎回GitHub Secretsへ書き戻す。
// ============================================================
function loadRefreshToken() {
  if (process.env.FREEE_REFRESH_TOKEN) return process.env.FREEE_REFRESH_TOKEN;
  if (fs.existsSync(LOCAL_TOKEN_PATH)) {
    return JSON.parse(fs.readFileSync(LOCAL_TOKEN_PATH, 'utf8')).refresh_token;
  }
  return null;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: FREEE_CLIENT_ID,
      client_secret: FREEE_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`トークン更新失敗 (${res.status}): ${body}\n` +
      'リフレッシュトークンが失効している可能性があります。FREEE_SETUP.md の手順で再認可してください。');
  }
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

// 新しいリフレッシュトークンをGitHub Secretsへ保存（sealed box暗号化）
async function persistRefreshToken(newToken) {
  if (!PAT_TOKEN || !GITHUB_REPOSITORY) {
    // ローカル実行時はファイルに保存
    fs.writeFileSync(LOCAL_TOKEN_PATH, JSON.stringify({ refresh_token: newToken, saved_at: new Date().toISOString() }, null, 2));
    console.log(`💾 新しいリフレッシュトークンを ${LOCAL_TOKEN_PATH} に保存しました`);
    return true;
  }
  const gh = {
    'Authorization': `Bearer ${PAT_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const keyRes = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/secrets/public-key`, { headers: gh });
      if (!keyRes.ok) throw new Error(`public-key取得失敗 (${keyRes.status})`);
      const { key, key_id } = await keyRes.json();

      const sodium = require('libsodium-wrappers');
      await sodium.ready;
      const encrypted = sodium.to_base64(
        sodium.crypto_box_seal(sodium.from_string(newToken), sodium.from_base64(key, sodium.base64_variants.ORIGINAL)),
        sodium.base64_variants.ORIGINAL
      );

      const putRes = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/secrets/FREEE_REFRESH_TOKEN`, {
        method: 'PUT',
        headers: { ...gh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value: encrypted, key_id }),
      });
      if (!putRes.ok) throw new Error(`Secret更新失敗 (${putRes.status}): ${await putRes.text()}`);
      console.log('🔐 FREEE_REFRESH_TOKEN シークレットを更新しました');
      return true;
    } catch (e) {
      console.error(`⚠️ Secret更新エラー (試行${attempt}/3): ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  return false;
}

// ============================================================
// 2. freee APIクライアント
// ============================================================
function freeeClient(accessToken) {
  const call = async (method, path, body) => {
    const res = await fetch(`${FREEE_API}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Api-Version': '2020-06-15',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`freee API ${method} ${path} 失敗 (${res.status}): ${await res.text()}`);
    }
    return res.json();
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
  };
}

async function fetchMasters(freee) {
  const cid = `company_id=${FREEE_COMPANY_ID}`;
  const [accountItems, taxes, walletables] = await Promise.all([
    freee.get(`/api/1/account_items?${cid}`).then(r => r.account_items.filter(a => a.available !== false)),
    freee.get(`/api/1/taxes/companies/${FREEE_COMPANY_ID}`).then(r => r.taxes.filter(t => t.available !== false)),
    freee.get(`/api/1/walletables?${cid}`).then(r => r.walletables),
  ]);
  return { accountItems, taxes, walletables };
}

// 未処理（消込待ち: status=1）の明細を取得
async function fetchUnprocessedTxns(freee) {
  const endDate = new Date().toISOString().split('T')[0];
  const start = new Date();
  start.setDate(start.getDate() - SYNC_DAYS);
  const startDate = start.toISOString().split('T')[0];

  const txns = [];
  for (let offset = 0; ; offset += 100) {
    const res = await freee.get(
      `/api/1/wallet_txns?company_id=${FREEE_COMPANY_ID}&start_date=${startDate}&end_date=${endDate}&limit=100&offset=${offset}`
    );
    txns.push(...res.wallet_txns);
    if (res.wallet_txns.length < 100) break;
  }
  return txns.filter(t => t.status === 1); // 1: 消込待ち（未処理）
}

// ============================================================
// 3. Claudeによる仕訳判定
// ============================================================
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          wallet_txn_id: { type: 'integer', description: '対象明細のID' },
          account_item_id: { type: 'integer', description: '選択した勘定科目のID（一覧にあるもののみ）' },
          tax_code: { type: 'integer', description: '選択した税区分コード（一覧にあるもののみ）' },
          description: { type: 'string', description: '摘要（取引内容の日本語要約）' },
          confidence: { type: 'number', description: '判定の確信度 0.0〜1.0' },
          reasoning: { type: 'string', description: '判定理由（簡潔に）' },
        },
        required: ['wallet_txn_id', 'account_item_id', 'tax_code', 'description', 'confidence', 'reasoning'],
        additionalProperties: false,
      },
    },
  },
  required: ['classifications'],
  additionalProperties: false,
};

async function classifyWithClaude(txns, masters) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const walletableName = (t) =>
    masters.walletables.find(w => w.id === t.walletable_id && w.type === t.walletable_type)?.name || t.walletable_type;

  const prompt = `あなたは日本の会計実務（小規模事業者の記帳・消費税区分）に精通した経理担当者です。
パーソナルトレーニングジム「TRAINER'S GYM」（東京・外苑前）の銀行口座・クレジットカード明細を仕訳してください。

## 事業の背景
- パーソナルトレーニングジムの運営。収入はセッション料金・会費（振込・カード決済・現金）
- 主な支出: 店舗家賃、水道光熱費、Web広告費（Google/Meta等）、トレーニング器具、消耗品、通信費、サブスク利用料 など

## 利用可能な勘定科目（この中からidを選ぶこと）
${masters.accountItems.map(a => `${a.id}: ${a.name}`).join('\n')}

## 利用可能な税区分（この中からcodeを選ぶこと）
${masters.taxes.map(t => `${t.code}: ${t.name_ja || t.name}`).join('\n')}

## 仕訳対象の明細
${JSON.stringify(txns.map(t => ({
    id: t.id,
    date: t.date,
    amount: t.amount,
    entry_side: t.entry_side, // income=入金 / expense=出金
    口座: walletableName(t),
    摘要: t.description,
  })), null, 2)}

## 指示
- 各明細に最適な account_item_id と tax_code を選んでください（必ず上記一覧の値を使うこと）
- entry_side が income なら収益系、expense なら費用・資産系の科目を選ぶこと
- 摘要文字列から取引先やサービス名を読み取り、description に日本語の摘要を書くこと
- 内容が曖昧・判断材料が乏しい明細は confidence を低くしてください（0.75未満は自動登録されず人間のレビューに回ります）
- すべての明細について必ず1件ずつ結果を返してください`;

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: CLASSIFICATION_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude が処理を拒否しました（refusal）');
  }
  const text = response.content.find(b => b.type === 'text')?.text;
  return JSON.parse(text).classifications;
}

// ============================================================
// 4. freeeへ取引登録
// ============================================================
async function registerDeal(freee, txn, cls) {
  const body = {
    company_id: Number(FREEE_COMPANY_ID),
    issue_date: txn.date,
    type: txn.entry_side === 'income' ? 'income' : 'expense',
    details: [{
      account_item_id: cls.account_item_id,
      tax_code: cls.tax_code,
      amount: txn.amount,
      description: cls.description,
    }],
    payments: [{
      amount: txn.amount,
      date: txn.date,
      from_walletable_type: txn.walletable_type,
      from_walletable_id: txn.walletable_id,
    }],
  };
  const res = await freee.post('/api/1/deals', body);
  return res.deal;
}

// ============================================================
// 5. ログ（二重登録防止 + 実行履歴）
// ============================================================
function loadLog() {
  try {
    if (fs.existsSync(LOG_PATH)) return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch (e) { /* 壊れていたら作り直す */ }
  return { processed: {}, runs: [] };
}

function saveLog(log) {
  if (log.runs.length > 60) log.runs = log.runs.slice(-60);
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

function writeSummary(registered, review, skippedCount) {
  const lines = [];
  lines.push(`# 🧾 freee自動仕訳 実行結果 ${DRY_RUN ? '（DRY RUN）' : ''}`);
  lines.push(`- 登録: ${registered.length}件 / 要レビュー: ${review.length}件 / 処理済みスキップ: ${skippedCount}件`);
  if (registered.length) {
    lines.push('\n## ✅ 登録した取引');
    lines.push('| 日付 | 金額 | 摘要 | 勘定科目ID | 確信度 |');
    lines.push('|---|---|---|---|---|');
    registered.forEach(r => lines.push(`| ${r.date} | ${r.amount.toLocaleString()}円 | ${r.description} | ${r.account_item_id} | ${r.confidence} |`));
  }
  if (review.length) {
    lines.push('\n## ⚠️ 要レビュー（確信度不足のため未登録 → freeeの「自動で経理」で手動処理してください）');
    lines.push('| 日付 | 金額 | 明細摘要 | AIの候補 | 確信度 | 理由 |');
    lines.push('|---|---|---|---|---|---|');
    review.forEach(r => lines.push(`| ${r.date} | ${r.amount.toLocaleString()}円 | ${r.raw_description} | ${r.description} | ${r.confidence} | ${r.reasoning} |`));
  }
  const md = lines.join('\n');
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

// ============================================================
// メイン
// ============================================================
(async () => {
  console.log(`🚀 freee自動仕訳 開始 ${new Date().toISOString()} ${DRY_RUN ? '(DRY RUN)' : ''}`);

  for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY, FREEE_CLIENT_ID, FREEE_CLIENT_SECRET, FREEE_COMPANY_ID })) {
    if (!v) { console.error(`❌ 環境変数 ${k} が未設定です。FREEE_SETUP.md を参照してください。`); process.exit(1); }
  }
  const refreshToken = loadRefreshToken();
  if (!refreshToken) { console.error('❌ リフレッシュトークンがありません。FREEE_SETUP.md の初回認可手順を実行してください。'); process.exit(1); }

  // --- トークン更新（旧リフレッシュトークンはここで失効する）---
  const token = await refreshAccessToken(refreshToken);
  console.log('🔑 アクセストークン取得OK');
  const persisted = await persistRefreshToken(token.refresh_token);
  if (!persisted) {
    console.error('🚨 新しいリフレッシュトークンの保存に失敗しました。次回実行前に FREEE_SETUP.md の手順で再認可が必要です。');
    process.exitCode = 1; // 処理は続行するが、失敗として目立たせる
  }

  const freee = freeeClient(token.access_token);

  // --- データ取得 ---
  const masters = await fetchMasters(freee);
  console.log(`📚 勘定科目: ${masters.accountItems.length}件 / 税区分: ${masters.taxes.length}件 / 口座: ${masters.walletables.length}件`);

  const log = loadLog();
  const allTxns = await fetchUnprocessedTxns(freee);
  // DRY RUNで記録されたものは実登録されていないので、処理済み扱いにしない
  const isDone = (t) => log.processed[t.id] && !log.processed[t.id].dry_run;
  const skipped = allTxns.filter(isDone);
  const targets = allTxns.filter(t => !isDone(t)).slice(0, MAX_TXNS);
  console.log(`💳 未処理明細: ${allTxns.length}件（処理済みスキップ: ${skipped.length}件 / 今回対象: ${targets.length}件）`);

  const registered = [];
  const review = [];

  if (targets.length > 0) {
    // --- Claudeで仕訳判定（20件ずつ）---
    const classifications = [];
    for (let i = 0; i < targets.length; i += 20) {
      const chunk = targets.slice(i, i + 20);
      console.log(`🤖 Claudeで仕訳判定中... (${i + 1}〜${i + chunk.length}件目)`);
      classifications.push(...await classifyWithClaude(chunk, masters));
    }

    const validAccountIds = new Set(masters.accountItems.map(a => a.id));
    const validTaxCodes = new Set(masters.taxes.map(t => t.code));

    // --- 登録 ---
    for (const txn of targets) {
      const cls = classifications.find(c => c.wallet_txn_id === txn.id);
      const base = { txn_id: txn.id, date: txn.date, amount: txn.amount, raw_description: txn.description };
      if (!cls || !validAccountIds.has(cls.account_item_id) || !validTaxCodes.has(cls.tax_code)) {
        review.push({ ...base, description: cls?.description || '(判定結果なし)', confidence: cls?.confidence ?? 0, reasoning: cls?.reasoning || 'AIの出力が不正（科目/税区分が一覧に存在しない）', ...cls });
        continue;
      }
      if (cls.confidence < MIN_CONFIDENCE) {
        review.push({ ...base, ...cls });
        continue;
      }
      try {
        let dealId = null;
        if (!DRY_RUN) {
          const deal = await registerDeal(freee, txn, cls);
          dealId = deal.id;
        }
        registered.push({ ...base, ...cls, deal_id: dealId });
        log.processed[txn.id] = { deal_id: dealId, date: txn.date, amount: txn.amount, account_item_id: cls.account_item_id, dry_run: DRY_RUN, at: new Date().toISOString() };
        console.log(`  ✅ ${txn.date} ${txn.amount.toLocaleString()}円 → ${cls.description} ${DRY_RUN ? '(dry run)' : `(deal ${dealId})`}`);
      } catch (e) {
        console.error(`  ❌ 取引登録失敗 (明細 ${txn.id}): ${e.message}`);
        review.push({ ...base, ...cls, reasoning: `登録APIエラー: ${e.message}` });
      }
    }
  }

  // --- ログ保存・サマリー ---
  log.runs.push({
    at: new Date().toISOString(), dry_run: DRY_RUN,
    unprocessed: allTxns.length, registered: registered.length, review: review.length,
  });
  saveLog(log);
  writeSummary(registered, review, skipped.length);
  console.log('🎉 完了');
})().catch(e => {
  console.error('❌ 実行エラー:', e.message);
  process.exit(1);
});
