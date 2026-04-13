const fs = require('fs');

// ============================================================
// 依存チェック
// ============================================================
let Anthropic, BetaAnalyticsDataClient;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch(e) {
  console.log('Warning: @anthropic-ai/sdk not installed yet');
}
try {
  const ga4 = require('@google-analytics/data');
  BetaAnalyticsDataClient = ga4.BetaAnalyticsDataClient;
} catch(e) {
  console.log('Warning: @google-analytics/data not installed yet');
}

const LP_TYPE = process.env.LP_TYPE || 'A';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_CREDENTIALS_RAW = process.env.GA4_CREDENTIALS;

// ============================================================
// 1. GA4からデータ取得
// ============================================================
async function getGA4Data() {
  if (!GA4_CREDENTIALS_RAW || !GA4_PROPERTY_ID) {
    console.log('⚠️ GA4設定なし - デフォルト値で改善実行');
    return { date: new Date().toISOString().split('T')[0], lpType: LP_TYPE, sessions: 0, bounceRate: 0, pageViews: 0, lineClicks: 0, scrollDepth: 0, conversions: 0, note: 'No GA4 config' };
  }

  try {
    const credentials = JSON.parse(GA4_CREDENTIALS_RAW);
    const analyticsClient = new BetaAnalyticsDataClient({ credentials });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    const [response] = await analyticsClient.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      dateRanges: [{ startDate: dateStr, endDate: dateStr }],
      dimensions: [{ name: 'eventName' }],
      metrics: [
        { name: 'sessions' },
        { name: 'bounceRate' },
        { name: 'screenPageViews' },
        { name: 'eventCount' },
      ],
    });

    let data = { date: dateStr, lpType: LP_TYPE, sessions: 0, bounceRate: 0, pageViews: 0, lineClicks: 0, scrollDepth: 0, conversions: 0 };

    if (response.rows) {
      response.rows.forEach(row => {
        const event = row.dimensionValues[0].value;
        const sessions = parseInt(row.metricValues[0].value) || 0;
        const bounceRate = parseFloat(row.metricValues[1].value) || 0;
        const pageViews = parseInt(row.metricValues[2].value) || 0;
        const eventCount = parseInt(row.metricValues[3].value) || 0;
        if (event === 'session_start') { data.sessions += sessions; data.bounceRate = bounceRate; data.pageViews += pageViews; }
        if (event === 'click') data.lineClicks += eventCount;
        if (event === 'scroll') data.scrollDepth = Math.round((eventCount / Math.max(sessions, 1)) * 100);
      });
    }
    console.log('✅ GA4データ取得成功:', JSON.stringify(data));
    return data;
  } catch (error) {
    console.error('GA4エラー:', error.message);
    return { date: new Date().toISOString().split('T')[0], lpType: LP_TYPE, sessions: 0, bounceRate: 0, pageViews: 0, lineClicks: 0, scrollDepth: 0, conversions: 0, error: error.message };
  }
}

// ============================================================
// 2. Claude APIでLP改善HTML生成
// ============================================================
async function optimizeLP(currentHTML, analytics) {
  if (!ANTHROPIC_API_KEY) {
    console.log('⚠️ ANTHROPIC_API_KEY未設定 - 改善スキップ');
    return null;
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const issues = [];
  if (analytics.bounceRate > 0.6) issues.push('直帰率が高い（60%超）→ ヒーロー強化・CTA改善');
  if (analytics.scrollDepth < 40 && analytics.sessions > 0) issues.push('スクロール深度低い（40%未満）→ コンテンツ前半強化');
  if (analytics.lineClicks < analytics.sessions * 0.05 && analytics.sessions > 0) issues.push('CTAクリック率低い→ ボタン文言・色・位置改善');
  if (analytics.sessions === 0) issues.push('初回実行 → コンバージョン率向上のベストプラクティスで改善');

  const prompt = `あなたはコンバージョン率最適化（CRO）の専門家です。

## LP-${analytics.lpType} 昨日のデータ
- セッション: ${analytics.sessions} / 直帰率: ${(analytics.bounceRate*100).toFixed(1)}% / LINEクリック: ${analytics.lineClicks} / スクロール深度: ${analytics.scrollDepth}%

## 改善ポイント
${issues.map(i => `- ${i}`).join('\n')}

## 改善指示
1. ヒーローのキャッチコピーをより感情に訴える言葉に変更
2. CTAボタンの文言に緊急性・具体性を追加（「今すぐ」「無料で」等）
3. 社会的証明（実績数字・口コミ）をより目立つ位置に配置
4. スクロールを促すビジュアルヒントを追加
5. スマホでタップしやすいUI改善

## 現在のHTML
${currentHTML.substring(0, 12000)}

改善したHTML全体を出力してください（<!DOCTYPE html>から</html>まで、説明文なし）。`;

  console.log('🤖 Claude API呼び出し中...');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }]
  });

  const result = message.content[0].text.trim();
  if (!result.includes('<!DOCTYPE') || result.length < 5000) {
    console.error('❌ 不正なHTML生成');
    return null;
  }
  return result;
}

// ============================================================
// 3. ログ保存
// ============================================================
function saveLog(analytics, note) {
  const logPath = 'optimization-log.json';
  let logs = [];
  try { if (fs.existsSync(logPath)) logs = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) {}
  logs.push({ ...analytics, timestamp: new Date().toISOString(), note });
  if (logs.length > 30) logs = logs.slice(-30);
  fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  console.log('📝 ログ保存完了');
}

// ============================================================
// メイン
// ============================================================
(async () => {
  console.log(`🚀 LP-${LP_TYPE} 最適化開始 ${new Date().toISOString()}`);

  const currentHTML = fs.readFileSync('index.html', 'utf8');
  console.log(`📄 現在HTML: ${currentHTML.length} bytes`);

  const analytics = await getGA4Data();

  if (ANTHROPIC_API_KEY) {
    const improvedHTML = await optimizeLP(currentHTML, analytics);
    if (improvedHTML) {
      fs.writeFileSync('index.html', improvedHTML);
      console.log(`✅ 改善HTML保存: ${improvedHTML.length} bytes`);
      saveLog(analytics, `${currentHTML.length} → ${improvedHTML.length} bytes`);
    } else {
      saveLog(analytics, 'HTML生成失敗 - スキップ');
    }
  } else {
    saveLog(analytics, 'ANTHROPIC_API_KEY未設定 - GA4データのみ記録');
    console.log('ℹ️ ANTHROPIC_API_KEY設定後に改善が有効になります');
  }

  console.log('✅ 完了');
})();
