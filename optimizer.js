const fs = require('fs');

const LP_TYPE = process.env.LP_TYPE || 'A';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_CREDENTIALS = process.env.GA4_CREDENTIALS;

// ============================================================
// 1. GA4データ取得
// ============================================================
async function getGA4Data() {
  if (!GA4_CREDENTIALS || !GA4_PROPERTY_ID) {
    console.log('⚠️ GA4設定なし - デフォルト値を使用');
    return { date: new Date().toISOString().split('T')[0], lpType: LP_TYPE, sessions: 0, bounceRate: 0, lineClicks: 0, scrollDepth: 0, conversions: 0, noData: true };
  }
  try {
    const { BetaAnalyticsDataClient } = require('@google-analytics/data');
    const credentials = JSON.parse(GA4_CREDENTIALS);
    const analyticsClient = new BetaAnalyticsDataClient({ credentials });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateFormatted = yesterday.toISOString().split('T')[0];

    const [response] = await analyticsClient.runReport({
      property: `properties/${GA4_PROPERTY_ID}`,
      dateRanges: [{ startDate: dateFormatted, endDate: dateFormatted }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'sessions' }, { name: 'bounceRate' }, { name: 'eventCount' }, { name: 'conversions' }],
    });

    let data = { date: dateFormatted, lpType: LP_TYPE, sessions: 0, bounceRate: 0, lineClicks: 0, scrollDepth: 0, conversions: 0 };
    if (response.rows) {
      response.rows.forEach(row => {
        const event = row.dimensionValues[0].value;
        const sessions = parseInt(row.metricValues[0].value) || 0;
        const bounceRate = parseFloat(row.metricValues[1].value) || 0;
        const eventCount = parseInt(row.metricValues[2].value) || 0;
        const conversions = parseInt(row.metricValues[3].value) || 0;
        if (event === 'session_start') { data.sessions += sessions; data.bounceRate = bounceRate; }
        if (event === 'click') { data.lineClicks += eventCount; data.conversions += conversions; }
        if (event === 'scroll') { data.scrollDepth = sessions > 0 ? Math.round(eventCount / sessions * 100) : 0; }
      });
    }
    return data;
  } catch (error) {
    console.error('GA4エラー:', error.message);
    return { date: new Date().toISOString().split('T')[0], lpType: LP_TYPE, sessions: 0, bounceRate: 0, lineClicks: 0, scrollDepth: 0, conversions: 0, error: error.message };
  }
}

// ============================================================
// 2. Claude APIでLP改善
// ============================================================
async function optimizeWithClaude(currentHTML, analytics) {
  if (!ANTHROPIC_API_KEY) {
    console.log('⚠️ ANTHROPIC_API_KEY未設定 - スキップ');
    return null;
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const dataSection = analytics.noData
    ? '- データ収集開始前（初回実行）→ コンバージョン率向上のベストプラクティスで全体改善'
    : `- セッション数: ${analytics.sessions}
- 直帰率: ${(analytics.bounceRate * 100).toFixed(1)}%
- LINEクリック数: ${analytics.lineClicks}
- スクロール深度: ${analytics.scrollDepth}%
- コンバージョン数: ${analytics.conversions}`;

  const prompt = `あなたはコンバージョン最適化の専門家です。以下のデータを元にLPのHTMLを改善してください。

## GA4データ（LP-${analytics.lpType} / ${analytics.date}）
${dataSection}

## 改善方針
${analytics.bounceRate > 0.6 ? '⚠️ 直帰率高 → ヒーローのキャッチコピー・CTA強化\n' : ''}${analytics.scrollDepth < 40 ? '⚠️ スクロール浅 → 上部コンテンツ魅力強化\n' : ''}${analytics.lineClicks < analytics.sessions * 0.05 && analytics.sessions > 0 ? '⚠️ CTA率低 → ボタン文言・色・緊急性を改善\n' : ''}
1. ヒーローのキャッチコピーをより感情に訴えるものに変更
2. CTAボタンの文言に緊急性・具体性を追加（例：「今すぐ」「本日限り」等）
3. 口コミ・実績をより目立つ位置に
4. スクロールを促す矢印やアニメーションを追加
5. モバイルのタップ領域を最適化

## 現在のHTML（要改善）
${currentHTML.substring(0, 15000)}

改善したHTMLのみ出力してください（<!DOCTYPE html>から</html>まで）。説明文不要。`;

  console.log('🤖 Claude APIで改善中...');
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }]
  });

  const result = message.content[0].text.trim();
  if (result.startsWith('<!DOCTYPE') || result.startsWith('<html')) return result;
  const match = result.match(/<!DOCTYPE[\s\S]*<\/html>/i);
  return match ? match[0] : null;
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
  console.log(`📄 現在のHTML: ${currentHTML.length} bytes`);

  const analytics = await getGA4Data();
  console.log('📊 GA4データ:', JSON.stringify(analytics));

  if (!ANTHROPIC_API_KEY) {
    console.log('ℹ️ ANTHROPIC_API_KEY未設定のためHTML更新スキップ');
    saveLog(analytics, 'API_KEY未設定 - スキップ');
    console.log('✅ 完了（最適化なし）');
    process.exit(0);
  }

  const improvedHTML = await optimizeWithClaude(currentHTML, analytics);
  if (!improvedHTML || improvedHTML.length < 5000) {
    console.error('❌ 改善HTML生成失敗');
    saveLog(analytics, '生成失敗');
    process.exit(1);
  }

  fs.writeFileSync('index.html', improvedHTML);
  console.log(`✅ 改善HTML保存: ${currentHTML.length} → ${improvedHTML.length} bytes`);
  saveLog(analytics, `${currentHTML.length} → ${improvedHTML.length} bytes`);
  console.log('🎉 最適化完了！');
})();
