/**
 * 高視認性 AAC 文字盤 Web アプリ (app.js)
 * SPDX-License-Identifier: MIT（アイコンの SVG は Material Symbols: Apache-2.0）
 * - brfvep 教育基本語彙DB + 文科省学年別漢字配当表 連動レベル制御
 * - 文脈考慮ワードプレディクション（品詞・意味分類・5枠多様性フィルタ）
 * - ユーザー固有シーケンス（Bigram/Trigram）＆文内共起学習
 * - ユーザー辞書登録・編集機能（CSV入出力）
 *
 * 構成：
 *   1. 定数・文字盤レイアウト定義     2. 後置変換トグルマップ・記号読み
 *   3. アプリケーション状態            4. DOM要素参照
 *   5. ストレージ・学習データ          6. 音声合成
 *   7. メッセージ欄描画                8. レベル調整・予測変換
 *   9. 文字盤描画とキー操作            10. モーダル・ユーザー辞書
 *   11. イベント登録                   12. Service Worker・初期化
 *
 * dict.js が定義する window.AAC_DICTIONARY / AAC_INITIAL_CANDIDATES / AAC_CONTEXT_SUGGESTIONS を参照する。
 */
(function () {
  'use strict';

  /* ========================================================================
     1. 定数・文字盤レイアウト定義
     ======================================================================== */
  const STORAGE_KEYS = {
    SETTINGS: 'commboard_settings_v2',
    LEARNING: 'commboard_learning_v2',
    USER_DICT: 'commboard_user_dict_v1'
  };

  // 学習テーブルごとの上限。超えたら、使用回数が少ない順（同数なら最終使用が古い順）に上限の90%まで間引く
  const LEARNING_LIMITS = {
    unigram: 3000,
    bigram: 3000,
    trigram: 3000,
    cooc: 5000
  };
  const LEARNING_PRUNE_RATIO = 0.9;
  // 容量不足でユーザー辞書・設定・学習データを保存できないときに、学習データを追加で間引く割合（各テーブルの件数をこの割合まで減らす）
  const LEARNING_EMERGENCY_RATIO = 0.5;
  const SAVE_FAILED_MESSAGE = '保存できませんでした（学習履歴をリセットすると空きができます）';

  // 入力中の文章の一時退避先（sessionStorage）。意図しない再読み込みでも文章が消えないようにする。
  // アプリを終了するとブラウザが消去するため、次回起動時は空の状態から始まる。
  const DRAFT_SESSION_KEY = 'commboard_draft_v1';

  const DEFAULT_SETTINGS = {
    theme: 'light',       // 'light' | 'dark'
    level: 7,             // 0: かな, 1〜6: 小1〜小6, 7: 一般（常用漢字）
    keySpeech: 'on',      // 'on' | 'off'
    speechRate: 1.0       // 0.6 | 0.8 | 1.0 | 1.2 | 1.4
  };

  const CATEGORY_LABELS = {
    person: '人名・呼称',
    food: '飲食・薬',
    place: '場所・施設',
    device: '日用品・機器',
    body: '身体・症状',
    general: 'その他名詞',
    intj: '定型フレーズ'
  };

  const PREDICTION_SLOT_COUNT = 5;
  const SETTINGS_TAP_COUNT = 3;          // 設定ボタンを開くのに必要な連続タップ数
  const SETTINGS_TAP_WINDOW_MS = 800;    // 連続タップとみなす間隔
  const MESSAGE_DOUBLE_TAP_MS = 320;     // メッセージ欄ダブルタップ判定
  const TOAST_DURATION_MS = 1500;
  const MESSAGE_MEDIUM_MIN_LEN = 15;     // メッセージ欄フォント「中」の文字数下限
  const MESSAGE_LONG_MIN_LEN = 29;       // メッセージ欄フォント「小」の文字数下限

  // 文字盤は全モード共通で 11列 × 5行。左端1列が制御キー、残り10列が文字キー。
  // 左端制御列：1段目=1文字消す(BS), 2段目=小゛゜ / A⇔a, 3段目=空白, 4段目=全消去, 5段目(左下)=文字種切替(地球儀)
  const CONTROL_KEYS = {
    backspace: { type: 'backspace', label: '1文字消す', aria: '1文字削除' },
    modifier: { type: 'modifier', label: '小゛゜', multi: true, aria: '小書き・濁点・半濁点変換' },
    caseToggle: { type: 'case', label: 'A⇔a', multi: true, aria: '大文字・小文字切替' },
    clear: { type: 'clear', label: '全消去', danger: true, aria: '全消去' },
    mode: { type: 'mode', label: 'あ/ア/A', aria: '文字種切替' }
  };

  function createSpaceKey(value) {
    return { type: 'space', label: '空白', value, multi: true, aria: '空白' };
  }

  function hiraganaToKatakana(str) {
    return str.replace(/[\u3041-\u3096]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) + 0x60)
    );
  }

  // 各行は「左端制御キー」＋「文字キー10個」。文字キーは文字列（1文字ずつ）または { label, aria } で指定する
  function buildGrid(controlColumn, charRows) {
    return charRows.map((chars, rowIndex) => {
      const charCells = (typeof chars === 'string' ? Array.from(chars) : chars).map((c) =>
        typeof c === 'string' ? { type: 'char', label: c } : { type: 'char', ...c }
      );
      return [controlColumn[rowIndex]].concat(charCells);
    });
  }

  // ひらがな：国語教育準拠の右から縦書き配列（右端の列から左へ あ行〜わ行）
  const HIRAGANA_ROWS = [
    'わらやまはなたさかあ',
    'をり、みひにちしきい',
    'んるゆむふぬつすくう',
    'ーれ。めへねてせけえ',
    '？ろよもほのとそこお'
  ];

  const JAPANESE_CONTROL_COLUMN = [
    CONTROL_KEYS.backspace,
    CONTROL_KEYS.modifier,
    createSpaceKey('　'),
    CONTROL_KEYS.clear,
    CONTROL_KEYS.mode
  ];

  const HIRAGANA_GRID = buildGrid(JAPANESE_CONTROL_COLUMN, HIRAGANA_ROWS);
  const KATAKANA_GRID = buildGrid(JAPANESE_CONTROL_COLUMN, HIRAGANA_ROWS.map(hiraganaToKatakana));

  // ABC順＋数字・算数記号：A〜Z(26) + 句読点類(4) + 数字0〜9(10) + 算数演算子・記号(10)
  const ABC_GRID = buildGrid(
    [
      CONTROL_KEYS.backspace,
      CONTROL_KEYS.caseToggle,
      createSpaceKey(' '),
      CONTROL_KEYS.clear,
      CONTROL_KEYS.mode
    ],
    [
      'ABCDEFGHIJ',
      'KLMNOPQRST',
      'UVWXYZ.,?!',
      '0123456789',
      [
        { label: '+', aria: 'たす' },
        { label: '-', aria: 'ひく' },
        { label: '×', aria: 'かける' },
        { label: '÷', aria: 'わる' },
        { label: '=', aria: 'イコール' },
        { label: '(', aria: 'かっこ' },
        { label: ')', aria: 'かっことじ' },
        { label: '<', aria: '小なり' },
        { label: '>', aria: '大なり' },
        { label: '%', aria: 'パーセント' }
      ]
    ]
  );

  const GRIDS_BY_MODE = {
    hiragana: HIRAGANA_GRID,
    katakana: KATAKANA_GRID,
    abc: ABC_GRID
  };

  // 文字種切替の循環順と、切替時の読み上げ
  const MODE_SEQUENCE = ['hiragana', 'katakana', 'abc'];
  const MODE_SPEECH = {
    hiragana: 'ひらがな',
    katakana: 'カタカナ',
    abc: 'エービーシー'
  };

  // 機能キーのアイコン（Google Material Symbols: language / backspace / delete。Apache License 2.0）
  const KEY_ICONS = {
    mode:
      '<svg class="key-icon" viewBox="0 -960 960 960" aria-hidden="true">' +
      '<path fill="currentColor" d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q83 0 155.5 31.5t127 86q54.5 54.5 86 127T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Zm0-82q26-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z"/>' +
      '</svg>',
    backspace:
      '<svg class="key-icon" viewBox="0 -960 960 960" aria-hidden="true">' +
      '<path fill="currentColor" d="m456-320 104-104 104 104 56-56-104-104 104-104-56-56-104 104-104-104-56 56 104 104-104 104 56 56Zm-96 160q-19 0-36-8.5T296-192L80-480l216-288q11-15 28-23.5t36-8.5h440q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H360Zm-40-320 160 240h320v-480H480L320-480Zm280 0Z"/>' +
      '</svg>',
    clear:
      '<svg class="key-icon" viewBox="0 -960 960 960" aria-hidden="true">' +
      '<path fill="currentColor" d="M280-120q-33 0-56.5-23.5T200-200v-520h-16q-17 0-28.5-11.5T144-760q0-17 11.5-28.5T184-800h176v-16q0-17 11.5-28.5T400-856h160q17 0 28.5 11.5T600-816v16h176q17 0 28.5 11.5T816-760q0 17-11.5 28.5T776-720h-16v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/>' +
      '</svg>'
  };

  /* ========================================================================
     2. 統合後置変換トグルマップ（小゛゜：小書き・濁点・半濁点 循環変換）
     ======================================================================== */
  const MODIFIER_MAP = {
    // ひらがな：あ行（う → ぅ → ゔ → う）
    'あ': 'ぁ', 'ぁ': 'あ',
    'い': 'ぃ', 'ぃ': 'い',
    'う': 'ぅ', 'ぅ': 'ゔ', 'ゔ': 'う',
    'え': 'ぇ', 'ぇ': 'え',
    'お': 'ぉ', 'ぉ': 'お',
    // か行
    'か': 'が', 'が': 'か',
    'き': 'ぎ', 'ぎ': 'き',
    'く': 'ぐ', 'ぐ': 'く',
    'け': 'げ', 'げ': 'け',
    'こ': 'ご', 'ご': 'こ',
    // さ行
    'さ': 'ざ', 'ざ': 'さ',
    'し': 'じ', 'じ': 'し',
    'す': 'ず', 'ず': 'す',
    'せ': 'ぜ', 'ぜ': 'せ',
    'そ': 'ぞ', 'ぞ': 'そ',
    // た行（つ → っ → づ → つ）
    'た': 'だ', 'だ': 'た',
    'ち': 'ぢ', 'ぢ': 'ち',
    'つ': 'っ', 'っ': 'づ', 'づ': 'つ',
    'て': 'で', 'で': 'て',
    'と': 'ど', 'ど': 'と',
    // は行（は → ば → ぱ → は）
    'は': 'ば', 'ば': 'ぱ', 'ぱ': 'は',
    'ひ': 'び', 'び': 'ぴ', 'ぴ': 'ひ',
    'ふ': 'ぶ', 'ぶ': 'ぷ', 'ぷ': 'ふ',
    'へ': 'べ', 'べ': 'ぺ', 'ぺ': 'へ',
    'ほ': 'ぼ', 'ぼ': 'ぽ', 'ぽ': 'ほ',
    // や行・わ行
    'や': 'ゃ', 'ゃ': 'や',
    'ゆ': 'ゅ', 'ゅ': 'ゆ',
    'よ': 'ょ', 'ょ': 'よ',
    'わ': 'ゎ', 'ゎ': 'わ',

    // カタカナ：ア行（ウ → ゥ → ヴ → ウ）
    'ア': 'ァ', 'ァ': 'ア',
    'イ': 'ィ', 'ィ': 'イ',
    'ウ': 'ゥ', 'ゥ': 'ヴ', 'ヴ': 'ウ',
    'エ': 'ェ', 'ェ': 'エ',
    'オ': 'ォ', 'ォ': 'オ',
    // カ行（カ → ガ → ヵ → カ、ケ → ゲ → ヶ → ケ）
    'カ': 'ガ', 'ガ': 'ヵ', 'ヵ': 'カ',
    'キ': 'ギ', 'ギ': 'キ',
    'ク': 'グ', 'グ': 'ク',
    'ケ': 'ゲ', 'ゲ': 'ヶ', 'ヶ': 'ケ',
    'コ': 'ゴ', 'ゴ': 'コ',
    // サ行
    'サ': 'ザ', 'ザ': 'サ',
    'シ': 'ジ', 'ジ': 'シ',
    'ス': 'ズ', 'ズ': 'ス',
    'セ': 'ゼ', 'ゼ': 'セ',
    'ソ': 'ゾ', 'ゾ': 'ソ',
    // タ行（ツ → ッ → ヅ → ツ）
    'タ': 'ダ', 'ダ': 'タ',
    'チ': 'ヂ', 'ヂ': 'チ',
    'ツ': 'ッ', 'ッ': 'ヅ', 'ヅ': 'ツ',
    'テ': 'デ', 'デ': 'テ',
    'ト': 'ド', 'ド': 'ト',
    // ハ行（ハ → バ → パ → ハ）
    'ハ': 'バ', 'バ': 'パ', 'パ': 'ハ',
    'ヒ': 'ビ', 'ビ': 'ピ', 'ピ': 'ヒ',
    'フ': 'ブ', 'ブ': 'プ', 'プ': 'フ',
    'ヘ': 'ベ', 'ベ': 'ペ', 'ペ': 'ヘ',
    'ホ': 'ボ', 'ボ': 'ポ', 'ポ': 'ホ',
    // ヤ行・ワ行
    'ヤ': 'ャ', 'ャ': 'ヤ',
    'ユ': 'ュ', 'ュ': 'ユ',
    'ヨ': 'ョ', 'ョ': 'ヨ',
    'ワ': 'ヮ', 'ヮ': 'ワ'
  };

  // アルファベット大文字↔小文字変換も追加
  for (let code = 65; code <= 90; code++) {
    const upper = String.fromCharCode(code);
    const lower = String.fromCharCode(code + 32);
    MODIFIER_MAP[upper] = lower;
    MODIFIER_MAP[lower] = upper;
  }

  const SYMBOL_SPEECH_MAP = {
    ' ': 'くうはく',
    '　': 'くうはく',
    '、': 'てん',
    '。': 'まる',
    '？': 'はてな',
    '?': 'はてな',
    '！': 'びっくり',
    '!': 'びっくり',
    'ー': 'のばす',
    '.': 'ピリオド',
    ',': 'カンマ',
    '+': 'たす',
    '-': 'ひく',
    '×': 'かける',
    '÷': 'わる',
    '=': 'イコール',
    '(': 'かっこ',
    ')': 'かっことじ',
    '<': 'しょうなり',
    '>': 'だいなり',
    '%': 'パーセント',
    // 拗音・促音・小書き文字の単音読み上げ（「小さい、よ」等）
    'ぁ': '小さい、あ',
    'ぃ': '小さい、い',
    'ぅ': '小さい、う',
    'ぇ': '小さい、え',
    'ぉ': '小さい、お',
    'っ': '小さい、つ',
    'ゃ': '小さい、や',
    'ゅ': '小さい、ゆ',
    'ょ': '小さい、よ',
    'ゎ': '小さい、わ',
    'ァ': '小さい、あ',
    'ィ': '小さい、い',
    'ゥ': '小さい、う',
    'ェ': '小さい、え',
    'ォ': '小さい、お',
    'ッ': '小さい、つ',
    'ャ': '小さい、や',
    'ュ': '小さい、ゆ',
    'ョ': '小さい、よ',
    'ヮ': '小さい、わ',
    'ヵ': '小さい、か',
    'ヶ': '小さい、け'
  };

  const DELIMITER_REGEX = /[\s　、。？！?!.,\n]/;
  const PARTICLES = ['から', 'まで', 'より', 'では', 'には', 'へは', 'を', 'が', 'に', 'へ', 'は', 'で', 'と', 'も', 'の'];

  /* ========================================================================
     3. アプリケーション状態
     ======================================================================== */
  const state = {
    chars: [],
    cursorIndex: 0,
    confirmedIndex: 0,        // 直前に予測候補を確定したカーソル境界
    sentenceTokens: [],       // 現在の文で確定したトークン履歴 [{ surface, base, r, p, cat, endIndex }]
    mode: 'hiragana',
    abcLower: false,          // ABCモード時の小文字状態フラグ（true: a〜z, false: A〜Z）
    settings: loadSettings(),
    learning: loadLearning(), // { unigram, bigram, trigram, cooc }
    learningIndex: null,      // Bigram / Trigram の逆引き索引（buildLearningIndex で作る）
    userDict: loadUserDict(), // ユーザー辞書配列
    editingUserDictIndex: -1,
    currentPredictions: [],
    readingRange: { start: 0, end: 0, raw: '', normalized: '' },
    speechUnlocked: false,
    isSpeakingAll: false,
    toastTimer: null,
    lastMessageTapTime: 0,
    settingsTapCount: 0,
    settingsTapTimer: null,
    pendingConfirmAction: null, // 確認ダイアログで実行ボタンが押されたときの処理
    waitingWorker: null,      // 待機中の新しい版の Service Worker
    updateRequested: false    // 設定画面から更新の適用を求めたか
  };
  state.learningIndex = buildLearningIndex(state.learning);

  /* ========================================================================
     4. DOM要素参照
     ======================================================================== */
  const dom = {
    messageDisplay: document.getElementById('message-display'),
    messageContent: document.getElementById('message-content'),
    btnCursorLeft: document.getElementById('btn-cursor-left'),
    btnCursorRight: document.getElementById('btn-cursor-right'),
    btnSpeakAll: document.getElementById('btn-speak-all'),
    iconSpeak: document.getElementById('icon-speak'),
    iconStop: document.getElementById('icon-stop'),
    labelSpeakAll: document.getElementById('label-speak-all'),
    btnExpand: document.getElementById('btn-expand'),
    btnCopy: document.getElementById('btn-copy'),
    btnSettings: document.getElementById('btn-settings'),
    predictionSlots: Array.from(document.querySelectorAll('.prediction-slot')),
    boardGrid: document.getElementById('board-grid'),

    // 拡大モーダル
    modalExpand: document.getElementById('modal-expand'),
    expandText: document.getElementById('expand-text'),
    btnExpandSpeak: document.getElementById('btn-expand-speak'),
    labelExpandSpeak: document.getElementById('label-expand-speak'),
    btnExpandCopy: document.getElementById('btn-expand-copy'),
    btnExpandClose: document.getElementById('btn-expand-close'),

    // 全消去確認モーダル
    modalConfirmClear: document.getElementById('modal-confirm-clear'),
    confirmClearTitle: document.getElementById('confirm-clear-title'),
    confirmClearNote: document.getElementById('confirm-clear-note'),
    confirmClearPreview: document.getElementById('confirm-clear-preview'),
    btnConfirmClearYes: document.getElementById('btn-confirm-clear-yes'),
    btnConfirmClearNo: document.getElementById('btn-confirm-clear-no'),

    // 設定モーダル
    modalSettings: document.getElementById('modal-settings'),
    btnSettingsClose: document.getElementById('btn-settings-close'),
    settingChoices: Array.from(document.querySelectorAll('.setting-choice')),
    btnOpenUserDict: document.getElementById('btn-open-user-dict'),
    userDictCount: document.getElementById('user-dict-count'),
    btnResetLearning: document.getElementById('btn-reset-learning'),
    settingRowAppUpdate: document.getElementById('setting-row-app-update'),
    btnApplyUpdate: document.getElementById('btn-apply-update'),

    // ユーザー辞書モーダル
    modalUserDict: document.getElementById('modal-user-dict'),
    btnUserDictClose: document.getElementById('btn-user-dict-close'),
    userDictReading: document.getElementById('user-dict-reading'),
    userDictSurface: document.getElementById('user-dict-surface'),
    userDictCat: document.getElementById('user-dict-cat'),
    btnImportBoardText: document.getElementById('btn-import-board-text'),
    btnUserDictSave: document.getElementById('btn-user-dict-save'),
    btnUserDictImportCsv: document.getElementById('btn-user-dict-import-csv'),
    btnUserDictExportCsv: document.getElementById('btn-user-dict-export-csv'),
    userDictCsvFile: document.getElementById('user-dict-csv-file'),
    userDictList: document.getElementById('user-dict-list'),

    // トースト
    toast: document.getElementById('toast')
  };

  /* ========================================================================
     5. ストレージ管理（設定・共起/シーケンス学習・ユーザー辞書）
     ======================================================================== */
  // localStorage の JSON 読み書き（プライベートブラウズ・容量超過・破損データでも例外を外へ出さない）
  function readStorageJSON(key) {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : null;
    } catch (_) {
      return null;
    }
  }

  function writeStorageJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadSettings() {
    const parsed = readStorageJSON(STORAGE_KEYS.SETTINGS);
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_SETTINGS };
    }
    let level = parsed.level !== undefined ? Number(parsed.level) : DEFAULT_SETTINGS.level;
    if (Number.isNaN(level) || level < 0 || level > 7) level = DEFAULT_SETTINGS.level;
    return {
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
      level,
      keySpeech: parsed.keySpeech === 'off' ? 'off' : 'on',
      speechRate: Number(parsed.speechRate) || DEFAULT_SETTINGS.speechRate
    };
  }

  // 保存に成功したら true。容量不足のときは学習データを間引いて空きを作り、もう一度試す
  function saveSettings() {
    return writeWithLearningFallback(STORAGE_KEYS.SETTINGS, state.settings);
  }

  function createEmptyLearning() {
    return {
      unigram: {}, // { [key]: { c: count, t: timestamp } }
      bigram: {},  // { ["prev->next"]: { c: count, t: timestamp } }
      trigram: {}, // { ["prev2|prev1->next"]: { c: count, t: timestamp } }
      cooc: {}     // { ["a<>b"]: { c: count, t: timestamp } }
    };
  }

  function loadLearning() {
    const parsed = readStorageJSON(STORAGE_KEYS.LEARNING);
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyLearning();
    }
    // 上限を超えたデータ（上限を設ける前に保存されたもの）は、次の保存時（saveLearning）に間引かれる
    return {
      unigram: parsed.unigram || {},
      bigram: parsed.bigram || {},
      trigram: parsed.trigram || {},
      cooc: parsed.cooc || {}
    };
  }

  // 学習データを保存する。上限を超えたテーブルは保存前に間引く。
  // 容量不足で失敗したら学習データをさらに間引いて再保存する（学習の保存失敗は利用者には通知しない）
  function saveLearning() {
    pruneLearningToLimits(state.learning, state.learningIndex);
    if (writeStorageJSON(STORAGE_KEYS.LEARNING, state.learning)) return true;
    shrinkLearning(LEARNING_EMERGENCY_RATIO);
    return writeStorageJSON(STORAGE_KEYS.LEARNING, state.learning);
  }

  // ユーザー辞書・設定は学習データより優先して保存する。
  // 容量不足で失敗したら、学習データを間引いて保存し直して空きを作り、もう一度試す。それでも失敗したら通知する
  function writeWithLearningFallback(key, value) {
    if (writeStorageJSON(key, value)) return true;
    if (shrinkLearning(LEARNING_EMERGENCY_RATIO) > 0) {
      writeStorageJSON(STORAGE_KEYS.LEARNING, state.learning);
      if (writeStorageJSON(key, value)) return true;
    }
    showToast(SAVE_FAILED_MESSAGE);
    return false;
  }

  /* --- 学習テーブルの間引き（プルーニング） --- */
  // 使用回数 c が少ない順、同数なら最終使用日時 t が古い順に並べたキー（先頭ほど先に消す）
  function keysInPruneOrder(table) {
    return Object.keys(table).sort((a, b) => {
      const sa = table[a];
      const sb = table[b];
      return (sa.c || 0) - (sb.c || 0) || (sa.t || 0) - (sb.t || 0);
    });
  }

  // table の件数を keepCount 件まで減らし、消したキーを返す
  function pruneTable(table, keepCount) {
    const keys = keysInPruneOrder(table);
    const removed = keys.slice(0, Math.max(0, keys.length - keepCount));
    removed.forEach((key) => {
      delete table[key];
    });
    return removed;
  }

  // 間引いたキーを逆引き索引からも消す（index が null なら何もしない）
  function removeFromLearningIndex(index, tableName, removedKeys) {
    if (!index || !index[tableName]) return;
    removedKeys.forEach((key) => indexRemove(index[tableName], key));
  }

  // 上限を超えたテーブルを上限の LEARNING_PRUNE_RATIO まで間引き、索引からも消す。消した件数を返す
  function pruneLearningToLimits(learning, index) {
    let removedCount = 0;
    Object.keys(LEARNING_LIMITS).forEach((tableName) => {
      const table = learning[tableName];
      const limit = LEARNING_LIMITS[tableName];
      if (Object.keys(table).length <= limit) return;
      const removed = pruneTable(table, Math.floor(limit * LEARNING_PRUNE_RATIO));
      removeFromLearningIndex(index, tableName, removed);
      removedCount += removed.length;
    });
    return removedCount;
  }

  // 容量不足のとき、すべてのテーブルを現在の件数の ratio まで減らす。消した件数を返す
  function shrinkLearning(ratio) {
    let removedCount = 0;
    Object.keys(LEARNING_LIMITS).forEach((tableName) => {
      const table = state.learning[tableName];
      const removed = pruneTable(table, Math.floor(Object.keys(table).length * ratio));
      removeFromLearningIndex(state.learningIndex, tableName, removed);
      removedCount += removed.length;
    });
    return removedCount;
  }

  /* --- Bigram / Trigram の逆引き索引（メモリ上のみ。保存形式は変えない） --- */
  // キー "前->次" を「前」→「次の集合」で引けるようにする。
  // 語のIDに "->" が含まれる場合も従来の前方一致（startsWith）と同じ結果になるよう、"->" が現れるすべての位置で登録する
  function forEachSequenceSplit(key, callback) {
    let pos = key.indexOf('->');
    while (pos !== -1) {
      callback(key.slice(0, pos), key.slice(pos + 2));
      pos = key.indexOf('->', pos + 1);
    }
  }

  function indexAdd(index, key) {
    forEachSequenceSplit(key, (prefix, next) => {
      let nexts = index.get(prefix);
      if (!nexts) {
        nexts = new Set();
        index.set(prefix, nexts);
      }
      nexts.add(next);
    });
  }

  function indexRemove(index, key) {
    forEachSequenceSplit(key, (prefix, next) => {
      const nexts = index.get(prefix);
      if (!nexts) return;
      nexts.delete(next);
      if (nexts.size === 0) index.delete(prefix);
    });
  }

  function buildLearningIndex(learning) {
    const index = { bigram: new Map(), trigram: new Map() };
    Object.keys(learning.bigram).forEach((key) => indexAdd(index.bigram, key));
    Object.keys(learning.trigram).forEach((key) => indexAdd(index.trigram, key));
    return index;
  }

  function bumpStat(table, key, weight = 1) {
    if (!key) return;
    const cur = table[key] || { c: 0, t: 0 };
    cur.c += weight;
    cur.t = Date.now();
    table[key] = cur;
  }

  // Bigram / Trigram を記録し、新しいキーなら索引にも加える
  function bumpSequence(tableName, key) {
    if (!state.learning[tableName][key]) {
      indexAdd(state.learningIndex[tableName], key);
    }
    bumpStat(state.learning[tableName], key, 1);
  }

  function getStatBonus(table, key, freqFactor, recencyMax) {
    const stat = table[key];
    if (!stat) return 0;
    const freqBonus = Math.min(stat.c * freqFactor, freqFactor * 12);
    // 直近30分以内の使用には高いRecencyボーナス、その後緩やかに減衰
    const ageMinutes = Math.max(0, (Date.now() - (stat.t || 0)) / 60000);
    const recencyBonus = recencyMax / (1 + ageMinutes / 15);
    return freqBonus + recencyBonus;
  }

  function getEntryId(entry) {
    return `${entry.r}:${entry.k}`;
  }

  // 学習テーブルのキー（localStorage に保存済みのデータと互換のある形式を維持すること）
  function bigramKey(prev1Id, curId) {
    return `${ prev1Id }->${ curId }`;
  }

  function trigramKey(prev2Id, prev1Id, curId) {
    return `${ prev2Id }|${ prev1Id }->${ curId }`;
  }

  function coocKey(idA, idB) {
    return idA < idB ? `${ idA }<>${ idB }` : `${ idB }<>${ idA }`;
  }

  // 同一文内の自立語（助詞以外）のうち、curId と異なるものを重複なく列挙する
  function forEachCoocPartner(tokens, curId, callback) {
    const seen = new Set();
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.p !== 'part' && tok.id !== curId && !seen.has(tok.id)) {
        seen.add(tok.id);
        callback(tok);
      }
    }
  }

  // 候補選択時のシーケンス（Unigram / Bigram / Trigram）＆文内共起学習記録
  function recordContextSelection(entry) {
    if (!entry) return;
    const curId = getEntryId(entry);
    bumpStat(state.learning.unigram, curId, 1);

    const tokens = state.sentenceTokens;
    const len = tokens.length;

    if (len >= 1) {
      bumpSequence('bigram', bigramKey(tokens[len - 1].id, curId));
    }
    if (len >= 2) {
      bumpSequence('trigram', trigramKey(tokens[len - 2].id, tokens[len - 1].id, curId));
    }

    // 同一文内の自立語との共起を記録（助詞以外のトークン同士）
    if (entry.p !== 'part') {
      forEachCoocPartner(tokens, curId, (tok) => {
        bumpStat(state.learning.cooc, coocKey(tok.id, curId), 1);
      });
    }

    saveLearning();
  }

  // 全文読み上げ／コピー実行時に文全体の共起・連接を強化
  function reinforceCurrentSentence() {
    const tokens = state.sentenceTokens;
    if (tokens.length < 2) return;

    const contentTokens = tokens.filter((t) => t.p !== 'part');
    for (let i = 0; i < contentTokens.length; i++) {
      for (let j = i + 1; j < contentTokens.length; j++) {
        const idA = contentTokens[i].id;
        const idB = contentTokens[j].id;
        if (idA !== idB) {
          bumpStat(state.learning.cooc, coocKey(idA, idB), 1);
        }
      }
    }
    saveLearning();
  }

  function loadUserDict() {
    const parsed = readStorageJSON(STORAGE_KEYS.USER_DICT);
    return Array.isArray(parsed) ? parsed : [];
  }

  // 保存に成功したら true（失敗時は writeWithLearningFallback が通知する）
  function saveUserDict() {
    return writeWithLearningFallback(STORAGE_KEYS.USER_DICT, state.userDict);
  }

  /* --- 入力中の文章（下書き）の退避・復元（sessionStorage） --- */
  const DRAFT_TOKEN_FIELDS = ['id', 'surface', 'speechText', 'base', 'r', 'p', 'cat', 'startIndex', 'endIndex'];

  function saveDraft() {
    try {
      if (state.chars.length === 0) {
        sessionStorage.removeItem(DRAFT_SESSION_KEY);
        return;
      }
      const tokens = state.sentenceTokens.map((t) => {
        const out = {};
        DRAFT_TOKEN_FIELDS.forEach((key) => {
          if (t[key] !== undefined) out[key] = t[key];
        });
        return out;
      });
      sessionStorage.setItem(
        DRAFT_SESSION_KEY,
        JSON.stringify({ chars: state.chars, cursorIndex: state.cursorIndex, tokens })
      );
    } catch (_) {
      // ignore
    }
  }

  function isRestorableToken(t) {
    return (
      t &&
      typeof t.id === 'string' &&
      typeof t.surface === 'string' &&
      Number.isInteger(t.startIndex) &&
      Number.isInteger(t.endIndex)
    );
  }

  // 退避した文章を state に戻す（カーソル位置の補正と、文字列と食い違うトークンの除外は renderMessage が行う）
  function restoreDraft() {
    let draft = null;
    try {
      const saved = sessionStorage.getItem(DRAFT_SESSION_KEY);
      draft = saved ? JSON.parse(saved) : null;
    } catch (_) {
      return;
    }
    if (!draft || !Array.isArray(draft.chars) || !draft.chars.every((c) => typeof c === 'string')) {
      return;
    }
    state.chars = draft.chars.slice();
    state.cursorIndex = Number.isInteger(draft.cursorIndex) ? draft.cursorIndex : state.chars.length;
    state.sentenceTokens = Array.isArray(draft.tokens)
      ? draft.tokens.filter(isRestorableToken).sort((a, b) => a.startIndex - b.startIndex)
      : [];
  }

  /* ========================================================================
     6. Web Speech API（オフライン優先＆Safariロック解除）
     ======================================================================== */
  let cachedVoices = [];

  function refreshVoices() {
    if (!('speechSynthesis' in window)) return;
    cachedVoices = window.speechSynthesis.getVoices() || [];
  }

  if ('speechSynthesis' in window) {
    refreshVoices();
    if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
      window.speechSynthesis.onvoiceschanged = refreshVoices;
    }
  }

  function unlockSpeech() {
    if (state.speechUnlocked || !('speechSynthesis' in window)) return;
    try {
      const utter = new SpeechSynthesisUtterance('');
      utter.volume = 0;
      window.speechSynthesis.speak(utter);
      state.speechUnlocked = true;
    } catch (_) {
      // ignore
    }
  }

  function selectBestVoice(text) {
    if (!cachedVoices.length) {
      refreshVoices();
    }
    if (!cachedVoices.length) return null;

    // アルファベット純粋文字列（A-Z, a-z）のみ英語音声、数字（0-9）や記号はすべて日本語音声エンジンで発声
    const isAsciiAlpha = /^[A-Za-z]+$/.test(text);
    const targetPrefix = isAsciiAlpha ? 'en' : 'ja';

    const localMatches = cachedVoices.filter(
      (v) => v.localService === true && v.lang && v.lang.toLowerCase().startsWith(targetPrefix)
    );
    if (localMatches.length > 0) {
      const preferred = localMatches.find((v) => /kyoko|otoya|hattori|o-ren|siri/i.test(v.name));
      return preferred || localMatches[0];
    }

    const jaLocal = cachedVoices.filter(
      (v) => v.localService === true && v.lang && v.lang.toLowerCase().startsWith('ja')
    );
    if (jaLocal.length > 0) {
      const preferredJa = jaLocal.find((v) => /kyoko|otoya/i.test(v.name));
      return preferredJa || jaLocal[0];
    }

    const anyLang = cachedVoices.find(
      (v) => v.lang && v.lang.toLowerCase().startsWith(targetPrefix)
    );
    return anyLang || cachedVoices[0] || null;
  }

  function setSpeakingAllUI(speaking) {
    state.isSpeakingAll = speaking;
    if (speaking) {
      dom.btnSpeakAll.classList.add('is-speaking');
      dom.iconSpeak.classList.add('hidden');
      dom.iconStop.classList.remove('hidden');
      dom.labelSpeakAll.textContent = '停止';
      dom.labelExpandSpeak.textContent = '停止';
    } else {
      dom.btnSpeakAll.classList.remove('is-speaking');
      dom.iconSpeak.classList.remove('hidden');
      dom.iconStop.classList.add('hidden');
      dom.labelSpeakAll.textContent = '読み上げ';
      dom.labelExpandSpeak.textContent = '読み上げ';
    }
  }

  function createUtterance(text) {
    const utter = new SpeechSynthesisUtterance(text);
    const voice = selectBestVoice(text);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    } else {
      utter.lang = 'ja-JP';
    }
    utter.rate = state.settings.speechRate;
    return utter;
  }

  // 発話中の音声（全文読み上げを含む）を打ち切って、すぐに text を読み上げる
  function speakText(text) {
    if (!text || !('speechSynthesis' in window)) return;
    try {
      setSpeakingAllUI(false);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(createUtterance(text));
    } catch (_) {
      // ignore
    }
  }

  // キー押下時の単音読み上げ（設定でOFFの場合は何もしない）
  function speakKey(rawChar) {
    if (state.settings.keySpeech !== 'on') return;
    speakText(SYMBOL_SPEECH_MAP[rawChar] || rawChar);
  }

  // 確定トークンの位置スパンが現在の文字列と一致しているか
  function isTokenInSync(t) {
    return (
      t.startIndex >= 0 &&
      t.endIndex <= state.chars.length &&
      state.chars.slice(t.startIndex, t.endIndex).join('') === t.surface
    );
  }

  // 全文読み上げ用の文字列を生成（画面表示が「かな」や「低学年漢字」でも、音声合成には一般的な漢字表記を使用）
  function buildSpeechTextForAll() {
    if (state.chars.length === 0) return '';

    const validTokens = state.sentenceTokens
      .filter((t) => t.startIndex < t.endIndex && isTokenInSync(t))
      .sort((a, b) => a.startIndex - b.startIndex);

    let out = '';
    let pos = 0;

    for (let i = 0; i < validTokens.length; i++) {
      const tok = validTokens[i];
      if (tok.startIndex < pos) continue;
      if (tok.startIndex > pos) {
        out += state.chars.slice(pos, tok.startIndex).join('');
      }
      out += tok.speechText || tok.surface;
      pos = tok.endIndex;
    }

    if (pos < state.chars.length) {
      out += state.chars.slice(pos).join('');
    }

    // 算数式の演算子（+ - × ÷ =）が全文読み上げでも自然に発音されるよう置換
    out = out
      .replace(/\+/g, ' たす ')
      .replace(/(\d)\s*-\s*(\d)/g, '$1 ひく $2')
      .replace(/×/g, ' かける ')
      .replace(/÷/g, ' わる ')
      .replace(/=/g, ' イコール ');

    return out.trim();
  }

  function toggleSpeakAll() {
    if (!('speechSynthesis' in window)) return;

    if (state.isSpeakingAll) {
      window.speechSynthesis.cancel();
      setSpeakingAllUI(false);
      return;
    }

    const speechText = buildSpeechTextForAll();
    if (!speechText) return;

    reinforceCurrentSentence();

    try {
      window.speechSynthesis.cancel();
      const utter = createUtterance(speechText);
      utter.onend = () => {
        setSpeakingAllUI(false);
      };
      utter.onerror = () => {
        setSpeakingAllUI(false);
      };

      setSpeakingAllUI(true);
      window.speechSynthesis.speak(utter);
    } catch (_) {
      setSpeakingAllUI(false);
    }
  }

  /* ========================================================================
     7. メッセージ欄＆明示的カーソル描画・トークンスパン同期
     ======================================================================== */
  function createCaretElement() {
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.setAttribute('aria-hidden', 'true');
    return caret;
  }

  // 文字挿入・削除・置換時に確定済みトークンの位置スパンを更新（壊れたトークンのみ除外）
  function adjustTokenSpansOnEdit(editStart, editEnd, insertedLength) {
    const removedLength = editEnd - editStart;
    const delta = insertedLength - removedLength;
    const nextTokens = [];

    for (let i = 0; i < state.sentenceTokens.length; i++) {
      const t = state.sentenceTokens[i];
      if (t.endIndex <= editStart) {
        nextTokens.push(t);
      } else if (t.startIndex >= editEnd) {
        nextTokens.push({
          ...t,
          startIndex: t.startIndex + delta,
          endIndex: t.endIndex + delta
        });
      }
      // 編集範囲と重なったトークンは未確定状態に戻すため除外
    }
    state.sentenceTokens = nextTokens;
  }

  function syncTokenBoundaryWithCursor() {
    // 現在の文字配列と一致している有効なトークンのみを保持
    state.sentenceTokens = state.sentenceTokens.filter(isTokenInSync);

    // カーソル位置以前で終わっている最後の確定トークン終端を confirmedIndex とする
    let latestEndBeforeCursor = 0;
    for (let i = 0; i < state.sentenceTokens.length; i++) {
      const t = state.sentenceTokens[i];
      if (t.endIndex <= state.cursorIndex && t.endIndex > latestEndBeforeCursor) {
        latestEndBeforeCursor = t.endIndex;
      }
    }
    state.confirmedIndex = latestEndBeforeCursor;
  }

  function renderMessage() {
    const frag = document.createDocumentFragment();
    const len = state.chars.length;

    if (state.cursorIndex < 0) state.cursorIndex = 0;
    if (state.cursorIndex > len) state.cursorIndex = len;
    syncTokenBoundaryWithCursor();

    for (let i = 0; i <= len; i++) {
      if (i === state.cursorIndex) {
        frag.appendChild(createCaretElement());
      }
      if (i < len) {
        const span = document.createElement('span');
        span.className = 'char';
        span.dataset.index = String(i);
        span.textContent = state.chars[i];
        frag.appendChild(span);
      }
    }

    if (len === 0) {
      const placeholder = document.createElement('span');
      placeholder.className = 'message-placeholder';
      placeholder.textContent = '文字盤をタップして入力';
      frag.appendChild(placeholder);
    }

    dom.messageContent.classList.toggle('msg-medium', len >= MESSAGE_MEDIUM_MIN_LEN && len < MESSAGE_LONG_MIN_LEN);
    dom.messageContent.classList.toggle('msg-long', len >= MESSAGE_LONG_MIN_LEN);
    dom.messageContent.replaceChildren(frag);

    if (!dom.modalExpand.classList.contains('hidden')) {
      dom.expandText.textContent = state.chars.join('') || '（未入力）';
    }

    requestAnimationFrame(() => {
      const caretEl = dom.messageContent.querySelector('.caret');
      if (caretEl) {
        caretEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }

  /* ========================================================================
     8. レベル調整・文脈考慮ワードプレディクション＆共起学習エンジン
     ======================================================================== */
  function katakanaToHiragana(str) {
    return str.replace(/[\u30A1-\u30F6]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0x60)
    );
  }

  // 設定された配当学年レベルに応じて、候補の画面表示文字列を決定（交ぜ書き防止・複合語対応）
  // level === 0（「かな」設定）のときはカタカナ語も含めてすべてひらがな表記に統一する
  function resolveSurfaceByLevel(entry, level) {
    if (level <= 0) {
      return katakanaToHiragana(entry.r || entry.h || entry.k || '');
    }
    if (entry.isUserDict) {
      return entry.k || entry.h || entry.r;
    }
    if (Array.isArray(entry.seg)) {
      return entry.seg
        .map(([hPart, kPart, gPart]) => (gPart <= level ? kPart : hPart))
        .join('');
    }
    const reqGrade = entry.g !== undefined ? entry.g : 0;
    return reqGrade <= level ? (entry.k || entry.h || entry.r) : (entry.h || entry.r);
  }

  // 音声合成（TTS）用の文字列を決定（表示学年に関わらず一般的な漢字表記を優先して正確な発音・アクセントを得る）
  function resolveSpeechText(entry) {
    return entry.k || entry.h || entry.r;
  }

  // 語彙レベル (v: 1=小低, 2=小高, 3=中学以上) と設定レベル (0〜7) の適合スコア
  function getVocabLevelAdjustment(entry, level) {
    if (entry.isUserDict) return 40;
    const v = entry.v || 1;
    if (level <= 2) {
      if (v === 1) return 18;
      if (v === 2) return -28;
      return -999; // 低学年モードでは中学抽象語を除外
    }
    if (level === 3) {
      if (v === 1) return 12;
      if (v === 2) return 0;
      return -999;
    }
    if (level <= 5) {
      if (v === 1) return 6;
      if (v === 2) return 4;
      return -35;
    }
    return 0; // 小6・一般では全語彙対象
  }

  function extractCurrentReading() {
    let delimStart = state.cursorIndex;
    while (delimStart > 0) {
      const prevChar = state.chars[delimStart - 1];
      if (DELIMITER_REGEX.test(prevChar)) {
        break;
      }
      delimStart--;
    }
    // 確定済み境界（confirmedIndex）と区切り文字の後ろ側を開始位置とする
    const start = Math.max(delimStart, state.confirmedIndex);
    const raw = state.chars.slice(start, state.cursorIndex).join('');
    const normalized = katakanaToHiragana(raw);
    return {
      start,
      end: state.cursorIndex,
      delimStart,
      raw,
      normalized
    };
  }

  // 文脈ブースト計算（品詞・意味分類・ユーザーBigram/Trigram・文内共起）
  function computeContextBoost(entry, contextTokens) {
    let boost = 0;
    const curId = getEntryId(entry);
    const len = contextTokens.length;

    // 1. ユーザー単体学習（Unigram）
    boost += getStatBonus(state.learning.unigram, curId, 12, 22);

    if (len > 0) {
      const prev1 = contextTokens[len - 1];

      const prev2 = len >= 2 ? contextTokens[len - 2] : null;

      // 2. ユーザー2語シーケンス（Bigram: W_{t-1} -> W_t）
      boost += getStatBonus(state.learning.bigram, bigramKey(prev1.id, curId), 35, 55);

      // 3. ユーザー3語シーケンス（Trigram: W_{t-2}|W_{t-1} -> W_t）
      if (prev2) {
        boost += getStatBonus(state.learning.trigram, trigramKey(prev2.id, prev1.id, curId), 50, 75);
      }

      // 4. 同一文内の共起ブースト（Sentence Co-occurrence）
      if (entry.p !== 'part') {
        forEachCoocPartner(contextTokens, curId, (tok) => {
          boost += getStatBonus(state.learning.cooc, coocKey(tok.id, curId), 20, 35);
        });
      }

      // 5. 品詞・意味カテゴリによる文法・コロケーション文脈
      if (prev1.p === 'part') {
        const part = prev1.r;
        const nounCat = prev2 && prev2.p === 'n' ? prev2.cat : null;

        if (part === 'を') {
          if (entry.p === 'vt') boost += 28;
          if (nounCat === 'food' && /^(のむ|たべる|くだ|もら|ほし)/.test(entry.r)) boost += 35;
          if (nounCat === 'device' && /^(つけ|けす|けし|あけ|しめ|とる|とっ|みる|みた|つか)/.test(entry.r)) boost += 35;
        } else if (part === 'が') {
          if (entry.p === 'adj' || entry.p === 'vi') boost += 26;
          if (nounCat === 'body' && /^(いた|かゆ|だる|くるし|わる|しび|つら)/.test(entry.r)) boost += 40;
          if (nounCat === 'food' && /^(のみ|たべ|ほし|すき)/.test(entry.r)) boost += 35;
        } else if (part === 'に' || part === 'へ') {
          if (entry.p === 'vi') boost += 26;
          if (nounCat === 'place' && /^(いく|いき|いっ|はい|すわ|もど|かえ)/.test(entry.r)) boost += 38;
        } else if (part === 'は') {
          if (entry.p === 'adj' || entry.p === 'intj' || entry.p === 'vi') boost += 16;
        }
      } else if (prev1.p === 'n') {
        if (entry.p === 'part') boost += 30;
        if (prev1.cat === 'body' && /^(いた|かゆ|だる)/.test(entry.r)) boost += 25;
        if (prev1.cat === 'food' && /^(のみ|たべ|くだ)/.test(entry.r)) boost += 25;
        if (prev1.cat === 'place' && /^(いき|いく)/.test(entry.r)) boost += 25;
      }
    }

    return boost;
  }

  // ユーザー辞書を内部エントリ形式に変換
  function getUserDictEntries() {
    return state.userDict.map((u) => ({
      r: katakanaToHiragana(u.r || ''),
      h: u.r || '',
      k: u.k || u.r || '',
      base: `user:${ u.r }`,
      w: 225,
      v: 1,
      g: 0,
      p: u.cat === 'intj' ? 'intj' : 'n',
      cat: u.cat || 'general',
      isUserDict: true
    }));
  }

  // 連続ひらがな入力時（例：「みずをの」）に助詞境界を検出して後半の読みを切り出す
  function detectInternalParticleSplit(normalizedReading, rawStart, dictList) {
    if (normalizedReading.length < 2) return null;

    for (let i = normalizedReading.length - 1; i >= 1; i--) {
      for (let pIdx = 0; pIdx < PARTICLES.length; pIdx++) {
        const part = PARTICLES[pIdx];
        if (normalizedReading.slice(0, i).endsWith(part)) {
          const nounReading = normalizedReading.slice(0, i - part.length);
          const suffixReading = normalizedReading.slice(i);
          if (nounReading.length >= 1 && suffixReading.length >= 1) {
            const matchedNoun = dictList.find((e) => e.r === nounReading && e.p === 'n');
            if (matchedNoun) {
              return {
                nounEntry: matchedNoun,
                particle: part,
                suffixReading,
                replaceStart: rawStart + i
              };
            }
          }
        }
      }
    }
    return null;
  }

  // 【ケースA】読み0文字：文頭なら初期候補、単語確定直後なら直前トークンに応じた後続候補
  function collectCandidatesWithoutReading(reading, activeTokens, userEntries, allDict) {
    if (activeTokens.length === 0) {
      // 文頭：初期頻出挨拶＋ユーザーがよく使う語
      const pool = userEntries.concat(window.AAC_INITIAL_CANDIDATES || []);
      return pool.map((entry) => ({
        entry,
        replaceStart: reading.start,
        score: entry.w + computeContextBoost(entry, [])
      }));
    }

    // 単語確定直後：直前トークンの品詞・意味分類＋ユーザーのBigram/Trigram学習候補
    const lastTok = activeTokens[activeTokens.length - 1];
    const prevTok = activeTokens.length >= 2 ? activeTokens[activeTokens.length - 2] : null;
    const rulePool = buildContextRulePool(lastTok, prevTok);

    // ユーザーが過去にこの文脈の直後に選んだ語もプールに追加
    const learnedNextIds = collectLearnedNextIds(lastTok, prevTok);
    if (learnedNextIds.size > 0) {
      for (let i = 0; i < allDict.length; i++) {
        const e = allDict[i];
        if (learnedNextIds.has(getEntryId(e))) {
          rulePool.push(e);
        }
      }
    }

    return rulePool.map((entry) => ({
      entry,
      replaceStart: reading.start,
      score: entry.w + computeContextBoost(entry, activeTokens)
    }));
  }

  // 直前トークン（と、その1つ前）の品詞・意味カテゴリから後続候補の規則プールを作る
  function buildContextRulePool(lastTok, prevTok) {
    const contextMap = window.AAC_CONTEXT_SUGGESTIONS || {};

    if (lastTok.p === 'n') {
      const catKey = lastTok.cat && contextMap[lastTok.cat] ? lastTok.cat : 'general_noun';
      return (contextMap[catKey] || []).slice();
    }
    if (lastTok.p !== 'part') {
      return (contextMap.verb_or_adj || []).slice();
    }

    if (lastTok.r === 'を') {
      let pool = (contextMap.particle_wo || []).slice();
      if (prevTok && prevTok.cat && contextMap[prevTok.cat]) {
        pool = pool.concat(contextMap[prevTok.cat].filter((e) => e.p !== 'part'));
      }
      return pool;
    }
    if (lastTok.r === 'が') {
      let pool = (contextMap.particle_ga || []).slice();
      if (prevTok && prevTok.cat === 'body' && contextMap.body) {
        pool = contextMap.body.filter((e) => e.p !== 'part').concat(pool);
      }
      return pool;
    }
    if (lastTok.r === 'に' || lastTok.r === 'へ') {
      return (contextMap.particle_ni || []).slice();
    }
    return (contextMap.particle_ha || []).slice();
  }

  // Bigram / Trigram の逆引き索引から、この文脈の直後に選ばれたことのある語のIDを集める
  function collectLearnedNextIds(lastTok, prevTok) {
    const ids = new Set();
    const addFrom = (index, prefix) => {
      const nexts = index.get(prefix);
      if (nexts) nexts.forEach((id) => ids.add(id));
    };
    // 索引のキーは "->" より前の部分（bigramKey / trigramKey の末尾の "->" を除いたもの）
    addFrom(state.learningIndex.bigram, bigramKey(lastTok.id, '').slice(0, -2));
    if (prevTok) {
      addFrom(state.learningIndex.trigram, trigramKey(prevTok.id, lastTok.id, '').slice(0, -2));
    }
    return ids;
  }

  // 【ケースB】1文字以上の読み入力中：前方一致・部分一致＋連続入力内の助詞境界による後半予測
  function collectCandidatesForReading(reading, activeTokens, allDict, level) {
    const candidates = [];

    for (let i = 0; i < allDict.length; i++) {
      const entry = allDict[i];
      const levelAdj = getVocabLevelAdjustment(entry, level);
      if (levelAdj < -500) continue;

      if (entry.r.startsWith(reading.normalized)) {
        const exactBonus = entry.r === reading.normalized ? 45 : 0;
        const lenDiffPenalty = Math.min(20, (entry.r.length - reading.normalized.length) * 2);
        const ctxBoost = computeContextBoost(entry, activeTokens);
        candidates.push({
          entry,
          replaceStart: reading.start,
          score: entry.w + levelAdj + exactBonus - lenDiffPenalty + ctxBoost
        });
      } else if (reading.normalized.length >= 2 && entry.r.includes(reading.normalized)) {
        const ctxBoost = computeContextBoost(entry, activeTokens);
        candidates.push({
          entry,
          replaceStart: reading.start,
          score: entry.w * 0.45 + levelAdj + ctxBoost
        });
      }
    }

    // 連続ひらがな入力で途中に助詞が含まれる場合（例：「みずをの」）の後半予測補完
    const splitInfo = detectInternalParticleSplit(reading.normalized, reading.start, allDict);
    if (splitInfo) {
      const virtualTokens = activeTokens.concat([
        {
          id: getEntryId(splitInfo.nounEntry),
          surface: splitInfo.nounEntry.k,
          base: splitInfo.nounEntry.base,
          r: splitInfo.nounEntry.r,
          p: 'n',
          cat: splitInfo.nounEntry.cat,
          endIndex: splitInfo.replaceStart - splitInfo.particle.length
        },
        {
          id: `${ splitInfo.particle }:${ splitInfo.particle }`,
          surface: splitInfo.particle,
          base: splitInfo.particle,
          r: splitInfo.particle,
          p: 'part',
          endIndex: splitInfo.replaceStart
        }
      ]);

      for (let i = 0; i < allDict.length; i++) {
        const entry = allDict[i];
        const levelAdj = getVocabLevelAdjustment(entry, level);
        if (levelAdj < -500) continue;

        if (entry.r.startsWith(splitInfo.suffixReading)) {
          const exactBonus = entry.r === splitInfo.suffixReading ? 40 : 0;
          const ctxBoost = computeContextBoost(entry, virtualTokens);
          candidates.push({
            entry,
            replaceStart: splitInfo.replaceStart,
            score: entry.w + levelAdj + exactBonus + ctxBoost + 15
          });
        }
      }
    }

    return candidates;
  }

  // 5枠多様性フィルタ（scoredCandidates はスコア降順であること）：
  // 1. 表示文字列（surface）の重複を除外
  // 2. 同一基本形（base）の活用バリエーションは最大2件までに制限
  // 3. 短い基本名詞がすでに選ばれており、現在の入力文字数がその基本名詞以下のときは、
  //    同じ基本名詞から始まる長い複合語・派生句は最大1件までに抑え、5枠が同一語頭の複合語で埋まるのを防ぐ
  function selectDiverseCandidates(scoredCandidates, readLen, level) {
    const seenSurface = new Set();
    const baseCounts = {};
    const selectedShortNounReadings = [];
    const compoundExtCounts = {};
    const result = [];

    for (let i = 0; i < scoredCandidates.length && result.length < PREDICTION_SLOT_COUNT; i++) {
      const cand = scoredCandidates[i];
      const entry = cand.entry;
      const surface = resolveSurfaceByLevel(entry, level);
      if (!surface || seenSurface.has(surface)) continue;

      const baseKey = entry.base || entry.r;
      const currentBaseCount = baseCounts[baseKey] || 0;
      if (currentBaseCount >= 2) continue;

      // 複合語の占有制御
      let blockedByCompoundLimit = false;
      for (let j = 0; j < selectedShortNounReadings.length; j++) {
        const headR = selectedShortNounReadings[j];
        if (entry.r.length > headR.length && entry.r.startsWith(headR) && readLen <= headR.length) {
          const extCount = compoundExtCounts[headR] || 0;
          if (extCount >= 1) {
            blockedByCompoundLimit = true;
            break;
          }
          compoundExtCounts[headR] = extCount + 1;
        }
      }
      if (blockedByCompoundLimit) continue;

      seenSurface.add(surface);
      baseCounts[baseKey] = currentBaseCount + 1;
      if (entry.p === 'n' && entry.r.length >= 2) {
        selectedShortNounReadings.push(entry.r);
      }
      result.push({
        surface,
        speechText: resolveSpeechText(entry),
        entry,
        replaceStart: cand.replaceStart
      });
    }

    return result;
  }

  function computePredictions() {
    const reading = extractCurrentReading();
    state.readingRange = reading;

    const level = state.settings.level;
    const userEntries = getUserDictEntries();
    const allDict = userEntries.concat(window.AAC_DICTIONARY || []);

    // 現在の文脈トークン列（区切り文字の後ろにある確定トークンのみ有効）
    const activeTokens = state.sentenceTokens.filter(
      (t) => t.endIndex > reading.delimStart && t.endIndex <= reading.start
    );

    const scoredCandidates = reading.normalized
      ? collectCandidatesForReading(reading, activeTokens, allDict, level)
      : collectCandidatesWithoutReading(reading, activeTokens, userEntries, allDict);

    scoredCandidates.sort((a, b) => b.score - a.score);

    state.currentPredictions = selectDiverseCandidates(scoredCandidates, reading.normalized.length, level);
    renderPredictions();
  }

  function renderPredictions() {
    for (let i = 0; i < PREDICTION_SLOT_COUNT; i++) {
      const slotBtn = dom.predictionSlots[i];
      const textSpan = slotBtn.querySelector('.prediction-text');
      const item = state.currentPredictions[i];

      if (item) {
        const charLen = Math.max(2, Array.from(item.surface).length);
        slotBtn.disabled = false;
        slotBtn.style.setProperty('--char-len', String(charLen));
        textSpan.textContent = item.surface;
        slotBtn.setAttribute('aria-label', `予測候補 ${ item.surface }`);
      } else {
        slotBtn.disabled = true;
        slotBtn.style.setProperty('--char-len', '4');
        textSpan.textContent = '';
        slotBtn.setAttribute('aria-label', '候補なし');
      }
    }
  }

  function applyPredictionSlot(slotIndex) {
    const item = state.currentPredictions[slotIndex];
    if (!item) return;

    const wordChars = Array.from(item.surface);
    const replaceStart = item.replaceStart !== undefined ? item.replaceStart : state.readingRange.start;
    const replaceEnd = state.readingRange.end;

    // 学習記録（現在のトークン履歴に対して記録）
    recordContextSelection(item.entry);

    // 既存トークンスパンの補正と文字列置換
    adjustTokenSpansOnEdit(replaceStart, replaceEnd, wordChars.length);
    state.chars.splice(replaceStart, replaceEnd - replaceStart, ...wordChars);
    const newCursor = replaceStart + wordChars.length;
    state.cursorIndex = newCursor;
    state.confirmedIndex = newCursor;

    state.sentenceTokens.push({
      id: getEntryId(item.entry),
      entry: item.entry,
      surface: item.surface,
      speechText: item.speechText || resolveSpeechText(item.entry),
      base: item.entry.base || item.entry.r,
      r: item.entry.r,
      p: item.entry.p || 'n',
      cat: item.entry.cat || '',
      startIndex: replaceStart,
      endIndex: newCursor
    });
    state.sentenceTokens.sort((a, b) => a.startIndex - b.startIndex);

    updateAll();
    // 画面表示は設定学年に応じた surface だが、音声合成は正確な発音のため一般的な漢字表記 (speechText) を渡す
    speakText(item.speechText || item.surface);
  }

  /* ========================================================================
     9. 文字盤グリッド描画とキー操作
     ======================================================================== */
  function renderBoardGrid() {
    const gridDef = GRIDS_BY_MODE[state.mode] || HIRAGANA_GRID;
    const isAbc = state.mode === 'abc';
    const frag = document.createDocumentFragment();

    gridDef.forEach((row) => {
      row.forEach((cell) => {
        frag.appendChild(createBoardKey(cell, isAbc));
      });
    });

    dom.boardGrid.replaceChildren(frag);
  }

  function createBoardKey(cell, isAbc) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'board-key';
    btn.classList.toggle('key-func', cell.type !== 'char');
    btn.classList.toggle('key-danger', Boolean(cell.danger));
    btn.classList.toggle('key-multi', Boolean(cell.multi));

    let displayLabel = cell.label;
    let keyValue = cell.value !== undefined ? cell.value : cell.label;

    if (isAbc && cell.type === 'char' && /^[A-Z]$/.test(cell.label)) {
      displayLabel = state.abcLower ? cell.label.toLowerCase() : cell.label;
      keyValue = displayLabel;
    } else if (cell.type === 'case') {
      displayLabel = state.abcLower ? 'a→A' : 'A→a';
    }

    btn.dataset.keyType = cell.type;
    btn.dataset.keyValue = keyValue;
    btn.setAttribute('aria-label', cell.aria || displayLabel);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'key-label';
    if (KEY_ICONS[cell.type]) {
      labelSpan.innerHTML = KEY_ICONS[cell.type];
    } else {
      labelSpan.textContent = displayLabel;
    }
    btn.appendChild(labelSpan);
    return btn;
  }

  function cycleMode() {
    const nextIndex = (MODE_SEQUENCE.indexOf(state.mode) + 1) % MODE_SEQUENCE.length;
    state.mode = MODE_SEQUENCE[nextIndex];
    speakKey(MODE_SPEECH[state.mode]);
    renderBoardGrid();
  }

  function toggleAbcCase() {
    state.abcLower = !state.abcLower;
    renderBoardGrid();
    speakKey(state.abcLower ? 'こもじ' : 'おおもじ');
  }

  function insertCharAtCursor(ch) {
    adjustTokenSpansOnEdit(state.cursorIndex, state.cursorIndex, 1);
    state.chars.splice(state.cursorIndex, 0, ch);
    state.cursorIndex += 1;
    updateAll();
    speakKey(ch);
  }

  function applyPostfixToggle(map) {
    if (state.cursorIndex <= 0) return;
    const targetIndex = state.cursorIndex - 1;
    const currentChar = state.chars[targetIndex];
    const converted = map[currentChar];
    if (!converted) return;

    adjustTokenSpansOnEdit(targetIndex, targetIndex + 1, 1);
    state.chars[targetIndex] = converted;
    updateAll();
    speakKey(converted);
  }

  function deleteCharBeforeCursor() {
    if (state.cursorIndex <= 0) return;
    adjustTokenSpansOnEdit(state.cursorIndex - 1, state.cursorIndex, 0);
    state.chars.splice(state.cursorIndex - 1, 1);
    state.cursorIndex -= 1;
    updateAll();
  }

  function moveCursor(delta) {
    const next = state.cursorIndex + delta;
    if (next < 0 || next > state.chars.length) return;
    state.cursorIndex = next;
    updateAll();
  }

  // 入力状態が変わったら必ずこれを呼ぶ（renderMessage 内でカーソル補正とトークン境界の同期も行う）
  function updateAll() {
    renderMessage();
    computePredictions();
    saveDraft();
  }

  /* ========================================================================
     10. コピー・全消去・拡大・設定・ユーザー辞書モーダル制御
     ======================================================================== */
  function showToast(message) {
    dom.toast.textContent = message;
    dom.toast.classList.remove('hidden');
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
    }
    state.toastTimer = setTimeout(() => {
      dom.toast.classList.add('hidden');
      state.toastTimer = null;
    }, TOAST_DURATION_MS);
  }

  async function copyFullText() {
    const text = state.chars.join('');
    if (!text) {
      showToast('コピーする文字がありません');
      return;
    }
    reinforceCurrentSentence();
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error('Clipboard API is not available');
      }
      await navigator.clipboard.writeText(text);
      showToast('コピーしました');
    } catch (_) {
      showToast('コピーできませんでした');
    }
  }

  function openExpandModal() {
    dom.expandText.textContent = state.chars.join('') || '（未入力）';
    dom.modalExpand.classList.remove('hidden');
  }

  function closeExpandModal() {
    dom.modalExpand.classList.add('hidden');
  }

  /* --- 消去の確認ダイアログ（全消去・学習履歴のリセット・ユーザー辞書の削除で共用） --- */
  /**
   * @param {object} options
   * @param {string} options.title 質問文
   * @param {string} [options.note] 補足文
   * @param {string} [options.preview] 消える内容のプレビュー
   * @param {string} options.confirmLabel 実行ボタンの文言
   * @param {() => void} options.onConfirm 実行ボタンが押されたときの処理（ダイアログを閉じてから呼ぶ）
   */
  function openConfirmDialog({ title, note = '', preview = '', confirmLabel, onConfirm }) {
    dom.confirmClearTitle.textContent = title;
    dom.confirmClearNote.textContent = note;
    dom.confirmClearNote.classList.toggle('hidden', !note);
    dom.confirmClearPreview.textContent = preview;
    dom.confirmClearPreview.classList.toggle('hidden', !preview);
    dom.btnConfirmClearYes.textContent = confirmLabel;
    state.pendingConfirmAction = onConfirm;
    dom.modalConfirmClear.classList.remove('hidden');
  }

  // 保留中の処理は次に openConfirmDialog を呼んだときに上書きされるので、閉じるだけでよい
  function closeConfirmDialog() {
    dom.modalConfirmClear.classList.add('hidden');
  }

  function runConfirmedAction() {
    const action = state.pendingConfirmAction;
    closeConfirmDialog();
    if (action) action();
  }

  function openConfirmClearModal() {
    if (state.chars.length === 0) return;
    openConfirmDialog({
      title: '入力した文章をすべて消去しますか？',
      preview: state.chars.join(''),
      confirmLabel: '消去する',
      onConfirm: executeClearAll
    });
  }

  function executeClearAll() {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setSpeakingAllUI(false);
    state.chars = [];
    state.cursorIndex = 0;
    state.confirmedIndex = 0;
    state.sentenceTokens = [];
    updateAll();
  }

  function applySettingsToDOM() {
    document.documentElement.setAttribute('data-theme', state.settings.theme);

    for (let i = 0; i < dom.settingChoices.length; i++) {
      const btn = dom.settingChoices[i];
      const key = btn.dataset.setting;
      const val = btn.dataset.value;
      const isSelected =
        key === 'speechRate' || key === 'level'
          ? Number(val) === Number(state.settings[key])
          : val === String(state.settings[key]);
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }

    if (dom.userDictCount) {
      dom.userDictCount.textContent = String(state.userDict.length);
    }
  }

  function openSettingsModal() {
    applySettingsToDOM();
    dom.modalSettings.classList.remove('hidden');
  }

  // 誤操作防止のため、設定ボタンはトリプルタップ（一定時間内に3回連続タップ）で開く
  function handleSettingsButtonTap() {
    state.settingsTapCount += 1;
    if (state.settingsTapTimer) {
      clearTimeout(state.settingsTapTimer);
    }
    if (state.settingsTapCount >= SETTINGS_TAP_COUNT) {
      state.settingsTapCount = 0;
      state.settingsTapTimer = null;
      openSettingsModal();
      return;
    }
    state.settingsTapTimer = setTimeout(() => {
      state.settingsTapCount = 0;
      state.settingsTapTimer = null;
    }, SETTINGS_TAP_WINDOW_MS);
  }

  function closeSettingsModal() {
    dom.modalSettings.classList.add('hidden');
  }

  function confirmResetLearningHistory() {
    openConfirmDialog({
      title: '学習履歴をすべて消去しますか？',
      note: 'ユーザー辞書や設定は消えません。',
      confirmLabel: '消去する',
      onConfirm: resetLearningHistory
    });
  }

  function resetLearningHistory() {
    state.learning = createEmptyLearning();
    state.learningIndex = buildLearningIndex(state.learning);
    saveLearning();
    computePredictions();
    showToast('学習履歴をリセットしました');
  }

  /* --- ユーザー辞書編集モーダル --- */
  function renderUserDictList() {
    if (dom.userDictCount) {
      dom.userDictCount.textContent = String(state.userDict.length);
    }
    if (!dom.userDictList) return;

    const frag = document.createDocumentFragment();
    if (state.userDict.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'user-dict-empty';
      empty.textContent = '登録されている単語はありません。上のフォームまたは「文字盤の入力文字を取り込む」から追加できます。';
      frag.appendChild(empty);
      dom.userDictList.replaceChildren(frag);
      return;
    }

    state.userDict.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'user-dict-item';

      const rSpan = document.createElement('span');
      rSpan.textContent = `読み：${ item.r }`;

      const kSpan = document.createElement('span');
      kSpan.textContent = `表記：${ item.k }`;

      const catSpan = document.createElement('span');
      catSpan.className = 'user-dict-item-cat';
      catSpan.textContent = CATEGORY_LABELS[item.cat] || '名詞';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'user-dict-item-btn';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => {
        state.editingUserDictIndex = idx;
        dom.userDictReading.value = item.r;
        dom.userDictSurface.value = item.k;
        dom.userDictCat.value = item.cat || 'general';
        dom.btnUserDictSave.textContent = '更新を保存';
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'user-dict-item-btn setting-action-danger';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', () => {
        openConfirmDialog({
          title: `『${ item.k }』を削除しますか？`,
          note: `読み：${ item.r }`,
          confirmLabel: '削除する',
          onConfirm: () => deleteUserDictEntry(item)
        });
      });

      row.appendChild(rSpan);
      row.appendChild(kSpan);
      row.appendChild(catSpan);
      row.appendChild(editBtn);
      row.appendChild(delBtn);
      frag.appendChild(row);
    });

    dom.userDictList.replaceChildren(frag);
  }

  function deleteUserDictEntry(item) {
    const idx = state.userDict.indexOf(item);
    if (idx < 0) return;
    state.userDict.splice(idx, 1);
    if (state.editingUserDictIndex === idx) {
      clearUserDictForm();
    } else if (state.editingUserDictIndex > idx) {
      // 編集中の項目より前を削除した場合は、編集対象のインデックスを詰める
      state.editingUserDictIndex -= 1;
    }
    const saved = saveUserDict();
    renderUserDictList();
    computePredictions();
    if (saved) showToast('削除しました');
  }

  function clearUserDictForm() {
    state.editingUserDictIndex = -1;
    if (dom.userDictReading) dom.userDictReading.value = '';
    if (dom.userDictSurface) dom.userDictSurface.value = '';
    if (dom.userDictCat) dom.userDictCat.value = 'person';
    if (dom.btnUserDictSave) dom.btnUserDictSave.textContent = '辞書に登録・保存';
  }

  function openUserDictModal() {
    closeSettingsModal();
    clearUserDictForm();
    renderUserDictList();
    if (dom.modalUserDict) {
      dom.modalUserDict.classList.remove('hidden');
    }
  }

  function closeUserDictModal() {
    if (dom.modalUserDict) {
      dom.modalUserDict.classList.add('hidden');
    }
  }

  function importBoardTextToUserDict() {
    const currentText = state.chars.join('').trim();
    if (!currentText) {
      showToast('文字盤に文字が入力されていません');
      return;
    }
    const hira = katakanaToHiragana(currentText);
    if (dom.userDictReading) dom.userDictReading.value = hira;
    if (dom.userDictSurface) dom.userDictSurface.value = currentText;
    showToast('入力文字を取り込みました');
  }

  function saveUserDictEntry() {
    if (!dom.userDictReading || !dom.userDictSurface) return;
    const rawR = dom.userDictReading.value.trim();
    const rawK = dom.userDictSurface.value.trim() || rawR;
    const cat = dom.userDictCat ? dom.userDictCat.value : 'person';

    if (!rawR) {
      showToast('「読み」を入力してください');
      return;
    }

    const normalizedR = katakanaToHiragana(rawR);
    const newItem = { r: normalizedR, k: rawK, cat };

    if (state.editingUserDictIndex >= 0 && state.editingUserDictIndex < state.userDict.length) {
      state.userDict[state.editingUserDictIndex] = newItem;
    } else {
      const existingIdx = state.userDict.findIndex((u) => u.r === normalizedR && u.k === rawK);
      if (existingIdx >= 0) {
        state.userDict[existingIdx] = newItem;
      } else {
        state.userDict.unshift(newItem);
      }
    }

    const saved = saveUserDict();
    clearUserDictForm();
    renderUserDictList();
    computePredictions();
    if (saved) showToast('ユーザー辞書に保存しました');
  }

  /* --- ユーザー辞書のCSVインポート・エクスポート（Excel / Numbers 対応） --- */
  function escapeCsvField(val) {
    const str = String(val ?? '');
    if (/[",\r\n]/.test(str)) {
      return `"${ str.replace(/"/g, '""') }"`;
    }
    return str;
  }

  function exportUserDictCSV() {
    const header = '読み,表記,種類';
    const rows = state.userDict.map((item) => {
      const catLabel = CATEGORY_LABELS[item.cat] || 'その他名詞';
      return [
        escapeCsvField(item.r),
        escapeCsvField(item.k),
        escapeCsvField(catLabel)
      ].join(',');
    });
    // ExcelやNumbersで文字化けしないようUTF-8 BOM (\uFEFF) を付与
    const csvContent = '\uFEFF' + [header].concat(rows).join('\r\n') + '\r\n';

    try {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'kanagrid_user_dict.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      showToast('CSVを書き出しました');
    } catch (_) {
      showToast('CSVの書き出しに失敗しました');
    }
  }

  function resolveCategoryFromCsv(rawCat, surface) {
    const s = String(rawCat || '').trim().toLowerCase();
    if (s) {
      if (CATEGORY_LABELS[s]) return s;
      if (s.includes('人') || s.includes('呼') || s === 'person') return 'person';
      if (s.includes('飲') || s.includes('食') || s.includes('薬') || s === 'food') return 'food';
      if (s.includes('場') || s.includes('施') || s.includes('室') || s === 'place') return 'place';
      if (s.includes('日用') || s.includes('機') || s.includes('道') || s === 'device') return 'device';
      if (s.includes('身') || s.includes('体') || s.includes('症') || s === 'body') return 'body';
      if (s.includes('定型') || s.includes('挨拶') || s.includes('フレーズ') || s === 'intj') return 'intj';
    }
    if (/(さん|くん|ちゃん|せんせい|先生|様)$/.test(surface)) {
      return 'person';
    }
    return 'general';
  }

  function parseCsvRow(line) {
    const delimiter = line.includes('\t') && !line.includes(',') ? '\t' : ',';
    const fields = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  }

  function importUserDictFromCSVText(csvText) {
    const cleanText = String(csvText || '').replace(/^\uFEFF/, '');
    const lines = cleanText.split(/\r?\n/);
    let importedCount = 0;
    let isFirstDataLine = true;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      const cols = parseCsvRow(line);
      const rawR = (cols[0] || '').trim();
      if (!rawR) continue;

      // ヘッダー行（「読み,表記,種類」等）はスキップ。先頭の空行・コメント行の後にあっても判定する
      const isHeader = isFirstDataLine && /^(読み|よみ|reading|r)$/i.test(rawR);
      isFirstDataLine = false;
      if (isHeader) {
        continue;
      }

      const rawK = (cols[1] || rawR).trim() || rawR;
      const cat = resolveCategoryFromCsv(cols[2], rawK);
      const normalizedR = katakanaToHiragana(rawR);

      const existingIdx = state.userDict.findIndex((u) => u.r === normalizedR && u.k === rawK);
      if (existingIdx >= 0) {
        state.userDict[existingIdx] = { r: normalizedR, k: rawK, cat };
      } else {
        state.userDict.push({ r: normalizedR, k: rawK, cat });
      }
      importedCount++;
    }

    if (importedCount > 0) {
      const saved = saveUserDict();
      renderUserDictList();
      computePredictions();
      if (saved) showToast(`CSVから${ importedCount }件読み込みました`);
    } else {
      showToast('読み込めるデータがありませんでした');
    }
    return importedCount;
  }

  function handleUserDictCsvFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target.result;
      let text = '';
      try {
        // まずUTF-8としてデコードを試み、不正バイトがあればExcel等のShift_JISとしてデコード
        const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
        text = utf8Decoder.decode(buffer);
      } catch (_) {
        try {
          const sjisDecoder = new TextDecoder('shift-jis');
          text = sjisDecoder.decode(buffer);
        } catch (__) {
          text = new TextDecoder().decode(buffer);
        }
      }
      importUserDictFromCSVText(text);
      event.target.value = '';
    };
    reader.readAsArrayBuffer(file);
  }

  /* ========================================================================
     11. イベントリスナー登録（標準 pointerdown / click 準拠）
     ======================================================================== */
  function bindEvents() {
    document.addEventListener('pointerdown', unlockSpeech, { passive: true });
    document.addEventListener('click', unlockSpeech, { passive: true });

    dom.boardGrid.addEventListener('click', (event) => {
      const keyBtn = event.target.closest('.board-key');
      if (!keyBtn) return;

      const type = keyBtn.dataset.keyType;
      const val = keyBtn.dataset.keyValue;

      switch (type) {
        case 'mode':
          cycleMode();
          break;
        case 'modifier':
          applyPostfixToggle(MODIFIER_MAP);
          break;
        case 'case':
          toggleAbcCase();
          break;
        case 'backspace':
          deleteCharBeforeCursor();
          break;
        case 'clear':
          openConfirmClearModal();
          break;
        case 'space':
        case 'char':
          insertCharAtCursor(val);
          break;
        default:
          break;
      }
    });

    dom.predictionSlots.forEach((slotBtn, index) => {
      slotBtn.addEventListener('click', () => {
        applyPredictionSlot(index);
      });
    });

    dom.messageDisplay.addEventListener('click', (event) => {
      const now = Date.now();
      if (now - state.lastMessageTapTime < MESSAGE_DOUBLE_TAP_MS) {
        state.lastMessageTapTime = 0;
        openExpandModal();
        return;
      }
      state.lastMessageTapTime = now;

      const charEl = event.target.closest('.char');
      if (charEl && charEl.dataset.index !== undefined) {
        const idx = Number(charEl.dataset.index);
        const rect = charEl.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        state.cursorIndex = event.clientX < midpoint ? idx : idx + 1;
        updateAll();
        return;
      }

      const firstChar = dom.messageContent.querySelector('.char');
      if (firstChar) {
        const firstRect = firstChar.getBoundingClientRect();
        if (event.clientX < firstRect.left) {
          state.cursorIndex = 0;
        } else {
          state.cursorIndex = state.chars.length;
        }
      } else {
        state.cursorIndex = 0;
      }
      updateAll();
    });

    dom.messageDisplay.addEventListener('dblclick', () => {
      openExpandModal();
    });

    dom.btnCursorLeft.addEventListener('click', () => moveCursor(-1));
    dom.btnCursorRight.addEventListener('click', () => moveCursor(1));
    dom.btnSpeakAll.addEventListener('click', toggleSpeakAll);
    dom.btnExpand.addEventListener('click', openExpandModal);
    dom.btnCopy.addEventListener('click', copyFullText);
    dom.btnSettings.addEventListener('click', handleSettingsButtonTap);

    dom.btnExpandSpeak.addEventListener('click', toggleSpeakAll);
    dom.btnExpandCopy.addEventListener('click', copyFullText);
    dom.btnExpandClose.addEventListener('click', closeExpandModal);

    dom.btnConfirmClearNo.addEventListener('click', closeConfirmDialog);
    dom.btnConfirmClearYes.addEventListener('click', runConfirmedAction);

    dom.btnSettingsClose.addEventListener('click', closeSettingsModal);
    dom.settingChoices.forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.setting;
        const rawVal = btn.dataset.value;
        if (!key) return;

        if (key === 'speechRate') {
          state.settings.speechRate = Number(rawVal) || 1.0;
        } else if (key === 'level') {
          state.settings.level = Number(rawVal);
        } else {
          state.settings[key] = rawVal;
        }

        saveSettings();
        applySettingsToDOM();
        computePredictions();
      });
    });

    dom.btnOpenUserDict.addEventListener('click', openUserDictModal);
    dom.btnResetLearning.addEventListener('click', confirmResetLearningHistory);
    dom.btnApplyUpdate.addEventListener('click', applyAppUpdate);
    dom.btnUserDictClose.addEventListener('click', closeUserDictModal);
    dom.btnImportBoardText.addEventListener('click', importBoardTextToUserDict);
    dom.btnUserDictSave.addEventListener('click', saveUserDictEntry);
    dom.btnUserDictExportCsv.addEventListener('click', exportUserDictCSV);
    dom.btnUserDictImportCsv.addEventListener('click', () => {
      dom.userDictCsvFile.click();
    });
    dom.userDictCsvFile.addEventListener('change', handleUserDictCsvFileChange);

    // モーダル外側（半透明の背景）タップで閉じる
    [dom.modalExpand, dom.modalConfirmClear, dom.modalSettings, dom.modalUserDict].forEach((modal) => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });
  }

  /* ========================================================================
     12. Service Worker 登録＆初期化
     ======================================================================== */
  // 新しい版の Service Worker は待機状態になり、次回起動時（アプリを閉じて開き直したとき）に切り替わる（sw.js 参照）。
  // 会話中に画面が再読み込みされないよう、自動では切り替えもリロードもしない。
  // 待機中の版があれば設定画面に「今すぐ更新する」を表示し、押されたときだけ切り替えて再読み込みする。
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      // 再読み込みするのは、設定画面で更新の適用を求めたときだけ。
      // 初回インストール時の clients.claim()（コントローラーが null → 新しい SW）や、
      // 別のタブで更新が適用されたことによるコントローラーの変化では再読み込みしない
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing || !state.updateRequested) return;
        refreshing = true;
        window.location.reload();
      });

      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('./sw.js', { updateViaCache: 'none' })
          .then((reg) => {
            watchForWaitingWorker(reg);
            reg.update().catch(() => {});
          })
          .catch(() => {
            // ignore
          });
      });
    }
  }

  // 新しい版がインストールされて待機状態になったら、設定画面に更新ボタンを表示する
  function watchForWaitingWorker(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) {
      showAppUpdate(reg.waiting);
    }
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        // controller が null なら初回インストールなので、更新ではない
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showAppUpdate(worker);
        }
      });
    });
  }

  function showAppUpdate(worker) {
    state.waitingWorker = worker;
    dom.settingRowAppUpdate.classList.remove('hidden');
  }

  // 入力中の文章は updateAll() のたびに sessionStorage へ退避済みなので、再読み込み後に復元される
  function applyAppUpdate() {
    if (!state.waitingWorker) return;
    state.updateRequested = true;
    state.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }

  function requestPersistentStorage() {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(() => {});
    }
  }

  function init() {
    requestPersistentStorage();
    restoreDraft();
    applySettingsToDOM();
    renderBoardGrid();
    updateAll();
    bindEvents();
    registerServiceWorker();
  }

  init();
})();
