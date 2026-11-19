/**
 * 拡張辞書データ（#31）
 *
 * SPDX-License-Identifier: CC-BY-4.0
 * このファイル（辞書データ）は クリエイティブ・コモンズ 表示 4.0 国際 ライセンス（CC BY 4.0）で提供します。
 * https://creativecommons.org/licenses/by/4.0/deed.ja
 * KanaGrid 辞書データ © 2026 Toshimitsu Yamaguchi
 *
 * 基本辞書（dict.js）にない地名や専門寄りの語を入れる、別ファイルの辞書です。
 * - 設定で拡張辞書を使うときだけ読み込みます（手で切り替えていなければ「一般」のときだけ使います）。
 * - 各語は dict.js の辞書と同じ欄に加えて、出典を表す src を持ちます。構成要素の欄（seg）は作りません。
 * - 基本辞書にある語（読みと表記の組）は入れません。候補の並べ方は app.js の selectPredictions を参照。
 *
 * 【出典】
 * 語を追加するときに、出典と加工・改変の内容をここに書きます（今はまだ語がありません）。
 */
window.AAC_DICTIONARY_EXT = [
];
