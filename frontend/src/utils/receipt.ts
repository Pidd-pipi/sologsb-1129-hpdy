import type { ReceiptRow } from '../types/reconcile';

/** 车间回执解析：制表符 / 逗号分隔文本 → 结构化回执行 */

/** 已知表头别名（命中即按表头定位列） */
const HEADER_ALIASES: Record<keyof Omit<ReceiptRow, 'lineNo' | 'rc' | 'raw' | 'positionText'>, string[]> = {
  code: ['字模编号', '编号', '字模号', 'code'],
  character: ['字符', '字', '汉字', 'character'],
  font: ['字体', '字型', 'font'],
  caseCode: ['字盘编号', '字盘', '盘号', 'case'],
};

const POSITION_ALIASES = ['盘内格位', '格位', '位置', '格', 'position'];

const FIELD_KEYS = ['code', 'character', 'font', 'caseCode'] as const;

/** 解析单行列文本：优先制表符，其次英文 / 中文逗号 */
function splitLine(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map((s) => s.trim());
  return line
    .split(/[,，]/)
    .map((s) => s.trim());
}

/** 格位原文 → 0 基行列。支持 A1、1-1、1行1列、第1行第1列；失败返回 null */
export function parsePosition(text: string): { row: number; col: number } | null {
  const t = (text || '').trim().toUpperCase();
  if (!t) return null;

  // A1 / AA12：字母为行（A=第 1 行），数字为列（1 基）
  const letter = t.match(/^([A-Z]+)\s*0*([0-9]+)$/);
  if (letter) {
    const digits = letter[1];
    let row1 = 0;
    for (const ch of digits) row1 = row1 * 26 + (ch.charCodeAt(0) - 64);
    const col1 = Number(letter[2]);
    if (row1 >= 1 && col1 >= 1) return { row: row1 - 1, col: col1 - 1 };
  }

  // 第1行第1列 / 1行1列 / 1-1 / 1–1
  const nums = t.match(/^(?:第)?\s*0*([0-9]+)\s*(?:行|排|-|–|—|,)\s*(?:第)?\s*0*([0-9]+)\s*列?$/);
  if (nums) {
    const row1 = Number(nums[1]);
    const col1 = Number(nums[2]);
    if (row1 >= 1 && col1 >= 1) return { row: row1 - 1, col: col1 - 1 };
  }
  return null;
}

function matchHeader(fields: string[]): Partial<Record<(typeof FIELD_KEYS)[number] | 'position', number>> | null {
  const map: Partial<Record<(typeof FIELD_KEYS)[number] | 'position', number>> = {};
  let hit = 0;
  fields.forEach((f, i) => {
    const norm = f.trim();
    for (const key of FIELD_KEYS) {
      if (HEADER_ALIASES[key].some((a) => a.toLowerCase() === norm.toLowerCase())) {
        map[key] = i;
        hit += 1;
        return;
      }
    }
    if (POSITION_ALIASES.some((a) => a.toLowerCase() === norm.toLowerCase())) {
      map.position = i;
      hit += 1;
    }
  });
  return hit >= 3 ? map : null;
}

/**
 * 解析整份回执。
 * 首行像表头（至少命中 3 个别名）则按表头定位，否则按固定列序
 * 编号 / 字符 / 字体 / 字盘 / 格位 解析。
 */
export function parseReceipt(raw: string): ReceiptRow[] {
  const lines = raw
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const firstFields = splitLine(lines[0]);
  const header = matchHeader(firstFields);
  const dataLines = header ? lines.slice(1) : lines;
  const idx = header ?? { code: 0, character: 1, font: 2, caseCode: 3, position: 4 };

  const rows: ReceiptRow[] = [];
  dataLines.forEach((line, i) => {
    const fields = splitLine(line);
    const get = (key: 'code' | 'character' | 'font' | 'caseCode' | 'position'): string =>
      (idx[key] !== undefined ? fields[idx[key] as number] : '') ?? '';
    const positionText = get('position');
    rows.push({
      lineNo: i + 1,
      code: get('code'),
      character: get('character'),
      font: get('font'),
      caseCode: get('caseCode'),
      positionText,
      rc: parsePosition(positionText),
      raw: line,
    });
  });
  return rows;
}

/** 回执内容哈希（FNV-1a）：同一回执再次提交时据此识别，避免重复生成结果 */
export function hashReceipt(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `rcpt-${(h >>> 0).toString(36).padStart(7, '0')}-${normalized.length.toString(36)}`;
}

/** 回执行是否缺必填字段（缺字段在核对阶段归入 bad-row） */
export function missingFieldsOf(row: ReceiptRow): string[] {
  const missing: string[] = [];
  if (!row.code) missing.push('字模编号');
  if (!row.character) missing.push('字符');
  if (!row.font) missing.push('字体');
  if (!row.caseCode) missing.push('字盘编号');
  if (!row.positionText) missing.push('盘内格位');
  else if (!row.rc) missing.push('格位格式');
  return missing;
}
