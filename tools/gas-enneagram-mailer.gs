/**
 * エニアグラム診断 結果メール送信
 * ---------------------------------------------------------------
 * 診断アプリ（enneagram.html）から結果を受け取り、
 * PDFに変換して本部・店舗担当者・受診者本人へメールで送る。
 *
 * 置き場所: Google Apps Script（script.google.com）
 * 動かすアカウント: trainers.gym00@gmail.com
 *
 * セットアップ手順は tools/README-mailer.md を参照。
 */

/* ============ 設定 ============ */

/** 本部（必ずここに届く） */
var HQ_EMAIL = 'trainers.gym00@gmail.com';

/**
 * 店舗・所属ごとの担当者メール。
 * 店長にも届けたい店舗だけ、右側にアドレスを書く。
 * 空のままなら本部にだけ届く。
 */
var MANAGERS = {
  '駒沢大学店': '',
  '高円寺店':   '',
  '江古田店':   '',
  '外苑前店':   '',
  '曙橋店':     '',
  '西荻窪店':   '',
  '幡ヶ谷店':   ''
};

/** 結果PDFをGoogleドライブにも残す場合、フォルダIDを入れる（空なら保存しない） */
var ARCHIVE_FOLDER_ID = '';

/** 送信元の表示名 */
var SENDER_NAME = 'エニアグラム診断';


/* ============ 受け口 ============ */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return reply({ ok: false, error: '送信内容が空です' });
    }
    var d = JSON.parse(e.postData.contents);

    if (!d.html) return reply({ ok: false, error: '結果データがありません' });

    var brand = d.brand || '診断';
    var name  = (d.name || '匿名').replace(/[\\\/:*?"<>|]/g, '_');
    var pdf   = toPdf(d, brand, name);

    // --- 本部（＋店舗担当者）へ ---
    var to = [HQ_EMAIL];
    var mgr = d.unit && MANAGERS[d.unit];
    if (mgr) to.push(mgr);

    GmailApp.sendEmail(to.join(','), subjectForStaff(d, brand), bodyForStaff(d), {
      name: SENDER_NAME + '（' + brand + '）',
      attachments: [pdf]
    });

    // --- 受診者本人へ（メールアドレスがある場合のみ） ---
    if (d.email && isEmail(d.email)) {
      GmailApp.sendEmail(d.email, '【' + brand + '】エニアグラム診断の結果をお送りします', bodyForPerson(d, brand), {
        name: SENDER_NAME + '（' + brand + '）',
        attachments: [pdf]
      });
    }

    archive(pdf);

    return reply({ ok: true });

  } catch (err) {
    // 失敗しても本部には気づけるようにしておく
    try {
      GmailApp.sendEmail(HQ_EMAIL, '【要確認】エニアグラム診断の送信に失敗しました', String(err) + '\n\n' + (e && e.postData ? e.postData.contents.slice(0, 2000) : ''));
    } catch (ignore) {}
    return reply({ ok: false, error: String(err) });
  }
}

/** 動作確認用。ブラウザでウェブアプリURLを開くとこれが返る。 */
function doGet() {
  return reply({ ok: true, message: 'エニアグラム診断の送信先として稼働しています' });
}


/* ============ 中身 ============ */

function toPdf(d, brand, name) {
  var fileName = ['エニアグラム診断', brand, name, (d.date || today())].join('_') + '.pdf';
  return Utilities
    .newBlob(d.html, 'text/html', fileName)
    .getAs('application/pdf')
    .setName(fileName);
}

function subjectForStaff(d, brand) {
  var who = d.name || '匿名';
  var unit = d.unit ? '／' + d.unit : '';
  return '【' + brand + unit + '】' + who + ' さん：タイプ' + d.type + ' ' + (d.typeName || '');
}

function bodyForStaff(d) {
  var L = [];
  L.push('エニアグラム診断の結果が届きました。詳細は添付PDFをご確認ください。');
  L.push('');
  L.push('お名前　　：' + (d.name || '—'));
  if (d.unit)  L.push('所属　　　：' + d.unit);
  if (d.email) L.push('メール　　：' + d.email);
  L.push('診断日　　：' + (d.date || today()));
  L.push('設問数　　：' + (d.questions || '—') + '問');
  L.push('');
  L.push('基本タイプ：' + d.type + ' ' + (d.typeName || ''));
  L.push('ウィング　：' + (d.wing || '—'));
  L.push('センター　：' + (d.center || '—'));
  L.push('');
  L.push(scoreLines(d.scores));
  return L.join('\n');
}

function bodyForPerson(d, brand) {
  var L = [];
  L.push((d.name || '') + ' 様');
  L.push('');
  L.push('エニアグラム診断へのご協力、ありがとうございました。');
  L.push('結果をPDFでお送りします。');
  L.push('');
  L.push('あなたの基本タイプは 「タイプ' + d.type + '　' + (d.typeName || '') + '」 でした。');
  L.push('');
  L.push('PDFには、タイプの解説にくわえて、');
  L.push('・向いているトレーニングのスタイル');
  L.push('・つまずきやすいポイント');
  L.push('・続けるためのコツ');
  L.push('をまとめています。担当スタッフと一緒にご活用ください。');
  L.push('');
  L.push('※ この診断は自己理解のためのものであり、医学的な診断ではありません。');
  L.push('');
  L.push(brand);
  return L.join('\n');
}

function scoreLines(scores) {
  if (!scores) return '';
  var names = {
    1: '改革する人', 2: '人を助ける人', 3: '達成する人', 4: '個性的な人', 5: '調べる人',
    6: '忠実な人', 7: '熱中する人', 8: '挑戦する人', 9: '平和をもたらす人'
  };
  var rows = [];
  for (var t = 1; t <= 9; t++) rows.push({ t: t, p: scores[t] });
  rows.sort(function (a, b) { return b.p - a.p; });

  var L = ['■ 全タイプのスコア'];
  rows.forEach(function (r) {
    L.push('　タイプ' + r.t + '　' + names[r.t] + '：' + r.p + '%');
  });
  return L.join('\n');
}

function archive(pdf) {
  if (!ARCHIVE_FOLDER_ID) return;
  try {
    DriveApp.getFolderById(ARCHIVE_FOLDER_ID).createFile(pdf);
  } catch (err) {
    // 保存に失敗してもメール送信は成立させる
  }
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
}

function today() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy年M月d日');
}

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
