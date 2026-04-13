const Anthropic = require('@anthropic-ai/sdk');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const fs = require('fs');

const LP_TYPE = process.env.LP_TYPE || 'A';

// ============================================================
// 1. GA4からデータ取得
// ============================================================
async function getGA4Data() {
  try {
    const credentials = JSON.parse(process.env.GA4_CREDENTIALS);
    const analyticsClient = new BetaAnalyticsDataClient({ credentials });
    const propertyId = process.env.GA4_PROPERTY_ID;

    // 昨日の日付
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0].replace(/-/g, '');
    const dateFormatted = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;

    const [response] = await analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: dateFormatted, endDate: dateFormatted }],
      dimensions: [
        { name: 'pagePath' },
        { name: 'eventName' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'bounceRate' },
        { name: 'screenPageViews' },
        { name: 'eventCount' },
        { name: 'conversions' },
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: {
            values: ['click', 'scroll', 'session_start', 'page_view']
          }
        }
      }
    });

    // LP-A or LP-Bのイベントデータを抽出
    const lpFilter = LP_TYPE === 'A' ? 'LP-A' : 'LP-B';
    let data = {
      date: dateFormatted,
      lpType: LP_TYPE,
      sessions: 0,
      bounceRate: 0,
      pageViews: 0,
      lineClicks: 0,
      scrollDepth: 0,
      conversions: 0,
    };

    if (response.rows) {
      response.rows.forEach(row => {
        const event = row.dimensionValues[1].value;
        const sessions = parseInt(row.metricValues[0].value) || 0;
        const bounceRate = parseFloat(row.metricValues[1].value) || 0;
        const pageViews = parseInt(row.metricValues[2].value) || 0;
        const eventCount = parseInt(row.metricValues[3].value) || 0;
        const conversions = parseInt(row.metricValues[4].value) || 0;

        if (event === 'session_start') {
          data.sessions += sessions;
          data.bounceRate = bounceRate;
          data.pageViews += pageViews;
        }
        if (event === 'click') {
          data.lineClicks += eventCount;
          data.conversions += conversions;
        }
        if (event === 'scroll') {
          data.scrollDepth = eventCount > 0 ? Math.round((eventCount / Math.max(sessions, 1)) * 100) : 0;
        }
      });
    }

    return data;

  } catch (error) {
    console.error('GA4取得エラー:', error.message);
    // GA4データなしでもClaude改善は実行
    return {
      date: new Date().toISOString().split('T')[0],
      lpType: LP_TYPE,
      sessions: 0,
      bounceRate: 0,
      pageViews: 0,
      lineClicks: 0,
      scrollDepth: 0,
      conversions: 0,
      error: error.message
    };
  }
}

// ============================================================
// 2. Claude APIでLP改善HTML生成
// ============================================================
async function optimizeLP(currentHTML, analytics) {
  const client = new Anthropic();

  const prompt = `あなたはコンバージョン最適化の専門家です。

## 昨日のアナリティクスデータ（LP-${analytics.lpType}）
- 日付: ${analytics.date}
- セッション数: ${analytics.sessions}
- 直帰率: ${(analytics.bounceRate * 100).toFixed(1)}%
- ページビュー: ${analytics.pageViews}
- LINEボタンクリック数: ${analytics.lineClicks}
- スクロール深度(平均%): ${analytics.scrollDepth}%
- コンバージョン数: ${analytics.conversions}
${analytics.error ? `- データ取得エラー（初回実行のため改善提案のみ）: ${analytics.error}` : ''}

## 改善タスク
上記データを分析して、以下の観点でLPのHTMLを改善してください：

${analytics.bounceRate > 0.6 ? '⚠️ 直帰率が高い（60%超）→ ヒーローセクションのメッセージ・写真・CTAボタンを強化' : ''}
${analytics.scrollDepth < 40 ? '⚠️ スクロール深度が低い（40%未満）→ 上部コンテンツの魅力を強化、スクロールを促す工夫を追加' : ''}
${analytics.lineClicks < analytics.sessions * 0.05 ? '⚠️ CTAクリック率が低い（5%未満）→ CTAボタンの文言・色・サイズ・位置を改善' : ''}
${analytics.sessions === 0 ? '📋 データなし（初回）→ コンバージョン率向上のベストプラクティスで全体改善' : ''}

改善の方針:
1. ヒーロー部のキャッチコピーをより感情に訴えるものに変更
2. 社会的証明（口コミ・実績）をより目立つ位置・デザインに
3. CTAボタンの緊急性・具体性を高める文言に変更
4. スクロールを促すビジュアル要素を追加
5. モバイルファーストでタップしやすいUI改善

## 現在のHTML
${currentHTML}

## 出力形式
改善したHTMLのみを出力してください。説明文・コードブロック記号は不要です。
HTMLのみ（<!DOCTYPE html>から</html>まで）を出力してください。`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content[0].text;
}

// ============================================================
// 3. 最適化ログ保存
// ============================================================
function saveLog(analytics, changes) {
  const logPath = 'optimization-log.json';
  let logs = [];
  if (fs.existsSync(logPath)) {
    try { logs = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) {}
  }
  logs.push({
    ...analytics,
    timestamp: new Date().toISOString(),
    changes: changes
  });
  // 直近30件のみ保持
  if (logs.length > 30) logs = logs.slice(-30);
  fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
}

// ============================================================
// メイン実行
// ============================================================
(async () => {
  console.log(`🚀 LP-${LP_TYPE} 最適化開始 ${new Date().toISOString()}`);

  // 現在のHTMLを読み込み
  const currentHTML = fs.readFileSync('index.html', 'utf8');
  console.log(`📄 現在のHTML: ${currentHTML.length} bytes`);

  // GA4データ取得
  console.log('📊 GA4データ取得中...');
  const analytics = await getGA4Data();
  console.log('GA4データ:', JSON.stringify(analytics, null, 2));

  // Claude APIで改善HTML生成
  console.log('🤖 Claude APIで改善HTML生成中...');
  const improvedHTML = await optimizeLP(currentHTML, analytics);

  if (!improvedHTML || improvedHTML.length < 1000) {
    console.error('❌ 改善HTML生成失敗 - スキップ');
    process.exit(1);
  }

  // 改善HTMLを保存
  fs.writeFileSync('index.html', improvedHTML);
  console.log(`✅ 改善HTML保存: ${improvedHTML.length} bytes`);

  // ログ保存
  const sizeChange = improvedHTML.length - currentHTML.length;
  saveLog(analytics, `HTML size: ${currentHTML.length} → ${improvedHTML.length} (${sizeChange > 0 ? '+' : ''}${sizeChange})`);

  console.log('🎉 最適化完了！Vercelへのデプロイはgit pushで自動実行されます。');
})();
