import type { CaseSlot, TypeCase } from '../types/case';
import type { MatrixFont, TypeMatrix } from '../types/matrix';
import type { ReceiptRow, ReconAction, ReconItem, ReconItemKind } from '../types/reconcile';
import { makeId } from './format';
import { rcKey } from './layout';
import { missingFieldsOf } from './receipt';

/** 盘点核对引擎：回执行 × 档案快照 → 核对条目（纯函数，不写任何档案） */

export interface AnalyzeContext {
  matrices: TypeMatrix[];
  cases: TypeCase[];
  /** 同一批次内已产出过「一枚双格」条目的字模，避免一枚字模重复提示 */
  doubledEmitted?: Set<string>;
}

/** 行号 → 字母（0=A），超过 Z 用 AA、AB… */
export function rowLetter(row: number): string {
  let n = row + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 格位的人读描述，例：A1 */
export function positionLabel(row: number, col: number): string {
  return `${rowLetter(row)}${col + 1}`;
}

/** 全库中某字模的落位 */
export function holdingsOf(
  cases: TypeCase[],
  matrixId: string,
): Array<{ typeCase: TypeCase; slots: CaseSlot[] }> {
  const out: Array<{ typeCase: TypeCase; slots: CaseSlot[] }> = [];
  for (const c of cases) {
    const slots = c.slots.filter((s) => s.matrixId === matrixId);
    if (slots.length > 0) out.push({ typeCase: c, slots });
  }
  return out;
}

/** 落位的人读描述清单，例：ZP-A-01 B2 */
export function holdingsTextOf(
  holdings: Array<{ typeCase: TypeCase; slots: CaseSlot[] }>,
): string[] {
  const out: string[] = [];
  for (const h of holdings) {
    for (const s of h.slots) out.push(`${h.typeCase.code} ${positionLabel(s.row, s.col)}`);
  }
  return out;
}

function buildItem(
  kind: ReconItemKind,
  row: ReceiptRow,
  partial: Partial<ReconItem> & Pick<ReconItem, 'message' | 'options'>,
): ReconItem {
  return {
    id: makeId('rcni'),
    kind,
    status: 'pending',
    receipt: row,
    snapshot: { holdingsText: [] },
    decision: '',
    ...partial,
  };
}

/** 移动字模到回执申报格位（与现格一致时不产生 place 动作） */
function moveAction(matrix: TypeMatrix, typeCase: TypeCase, row: ReceiptRow): ReconAction['place'] {
  return {
    caseId: typeCase.id,
    row: row.rc!.row,
    col: row.rc!.col,
    matrixId: matrix.id,
    character: matrix.character,
  };
}

/**
 * 逐条核对一条回执。返回 null 表示该行不需要单独成条
 * （例如「一枚双格」已在其他行提示过）。
 */
export function analyzeRow(row: ReceiptRow, ctx: AnalyzeContext): ReconItem | null {
  const { matrices, cases, doubledEmitted = new Set<string>() } = ctx;

  // 1) 回执自身异常：字段缺失 / 格位无法解析 / 越界
  const missing = missingFieldsOf(row);
  if (missing.length > 0) {
    return buildItem('bad-row', row, {
      message: `回执行缺少或无法解析：${missing.join('、')}`,
      options: ['ignore'],
    });
  }

  const typeCase = cases.find((c) => c.code.trim() === row.caseCode.trim());
  if (!typeCase) {
    return buildItem('unknown-case', row, {
      message: `字盘 ${row.caseCode} 在档案中不存在，无法核对格位`,
      options: ['ignore'],
    });
  }

  const rc = row.rc!;
  if (rc.row >= typeCase.rows || rc.col >= typeCase.cols) {
    return buildItem('bad-row', row, {
      message: `格位 ${row.positionText} 超出字盘 ${typeCase.code} 范围（${typeCase.rows} 行 × ${typeCase.cols} 列）`,
      options: ['ignore'],
      snapshot: { caseId: typeCase.id, holdingsText: [] },
    });
  }

  const matrix = matrices.find((m) => m.code.trim() === row.code.trim());
  const declaredSlot = typeCase.slots.find((s) => s.row === rc.row && s.col === rc.col);
  const holdings = holdingsOf(cases, matrix?.id ?? '');
  const inThisCase = holdings.find((h) => h.typeCase.id === typeCase.id);
  const elsewhere = holdings.filter((h) => h.typeCase.id !== typeCase.id);

  // 2) 编号配得上
  if (matrix) {
    const charSame = matrix.character === row.character;
    const fontSame = matrix.font === row.font;
    const atDeclared = Boolean(
      inThisCase && inThisCase.slots.some((s) => s.row === rc.row && s.col === rc.col),
    );

    // 一枚字模占两个（或以上）格位：先列待裁定
    const totalOccupied = holdings.reduce((n, h) => n + h.slots.length, 0);
    if (totalOccupied >= 2 && !doubledEmitted.has(matrix.id)) {
      doubledEmitted.add(matrix.id);
      const allSlots = holdings.flatMap((h) =>
        h.slots.map((s) => ({ caseId: h.typeCase.id, row: s.row, col: s.col })),
      );
      const onDeclared = allSlots.some((s) => s.caseId === typeCase.id && s.row === rc.row && s.col === rc.col);
      const proposedAction: ReconAction = onDeclared
        ? {
            decision: 'keep-declared',
            take: allSlots.filter(
              (s) => !(s.caseId === typeCase.id && s.row === rc.row && s.col === rc.col),
            ),
          }
        : {
            decision: 'keep-declared',
            place: moveAction(matrix, typeCase, row),
            take: allSlots,
          };
      return buildItem('double-slot', row, {
        status: 'pending',
        message: `字模 ${matrix.code}（${matrix.character}）在档案中同时占 ${totalOccupied} 个格位：${holdingsTextOf(holdings).join('、')}`,
        options: ['keep-declared', 'remove-all'],
        proposedAction,
        snapshot: {
          matrixId: matrix.id,
          caseId: typeCase.id,
          matrixCode: matrix.code,
          matrixCharacter: matrix.character,
          matrixFont: matrix.font,
          matrixAvailability: matrix.availability,
          holdingsText: holdingsTextOf(holdings),
        },
      });
    }

    // 已停用 / 待补刻的字模出现在盘内
    if (matrix.availability !== '可用' && (atDeclared || inThisCase)) {
      return buildItem('disabled-found', row, {
        status: 'pending',
        message: `字模 ${matrix.code}（${matrix.character}）已标记「${matrix.availability}」，但仍在字盘 ${typeCase.code} 格位 ${
          inThisCase ? inThisCase.slots.map((s) => positionLabel(s.row, s.col)).join('、') : positionLabel(rc.row, rc.col)
        }`,
        options: ['reactivate-keep', 'deactivate-remove'],
        snapshot: {
          matrixId: matrix.id,
          caseId: typeCase.id,
          matrixCode: matrix.code,
          matrixCharacter: matrix.character,
          matrixFont: matrix.font,
          matrixAvailability: matrix.availability,
          holdingsText: holdingsTextOf(holdings),
        },
      });
    }

    // 字符或字体对不上
    if (!charSame || !fontSame) {
      const diffs: string[] = [];
      if (!charSame) diffs.push(`字符（档案 ${matrix.character} → 回执 ${row.character}）`);
      if (!fontSame) diffs.push(`字体（档案 ${matrix.font} → 回执 ${row.font}）`);
      const patch: NonNullable<ReconItem['proposedAction']>['matrixPatch'] = { matrixId: matrix.id };
      if (!charSame) patch.character = row.character;
      if (!fontSame) patch.font = row.font as MatrixFont;
      const needMove = !atDeclared;
      return buildItem('char-font-mismatch', row, {
        status: 'pending',
        message: `编号 ${row.code} 配对成功，但${diffs.join('、')}不符`,
        options: ['accept-correction', 'reject-receipt'],
        proposedAction: {
          decision: 'accept-correction',
          matrixPatch: patch,
          ...(needMove ? { place: moveAction({ ...matrix, character: row.character }, typeCase, row) } : {}),
        },
        snapshot: {
          matrixId: matrix.id,
          caseId: typeCase.id,
          matrixCode: matrix.code,
          matrixCharacter: matrix.character,
          matrixFont: matrix.font,
          matrixAvailability: matrix.availability,
          holdingsText: holdingsTextOf(holdings),
        },
      });
    }

    // 字符 / 字体相符，仅格位不符 → 改号后（编号仍可配）按字符、字体与盘内格位确认
    if (!atDeclared) {
      const nowText = inThisCase
        ? inThisCase.slots.map((s) => positionLabel(s.row, s.col)).join('、')
        : elsewhere.length > 0
          ? holdingsTextOf(holdings).join('、')
          : '未落位';
      return buildItem('slot-moved', row, {
        status: 'proposed',
        decision: 'accept-move',
        message: `字模 ${matrix.code}（${matrix.character}）现落位 ${nowText}，回执申报 ${typeCase.code} ${positionLabel(rc.row, rc.col)}`,
        options: ['accept-move', 'keep-placement'],
        proposedAction: {
          decision: 'accept-move',
          place: moveAction(matrix, typeCase, row),
        },
        snapshot: {
          matrixId: matrix.id,
          caseId: typeCase.id,
          matrixCode: matrix.code,
          matrixCharacter: matrix.character,
          matrixFont: matrix.font,
          matrixAvailability: matrix.availability,
          holdingsText: holdingsTextOf(holdings),
        },
      });
    }

    // 全部相符
    return buildItem('matched', row, {
      status: 'accepted',
      decision: 'accept',
      message: `字模 ${matrix.code}（${matrix.character}）编号、字符、字体与格位 ${positionLabel(rc.row, rc.col)} 全部相符`,
      options: ['accept'],
      action: { decision: 'accept' },
      snapshot: {
        matrixId: matrix.id,
        caseId: typeCase.id,
        matrixCode: matrix.code,
        matrixCharacter: matrix.character,
        matrixFont: matrix.font,
        matrixAvailability: matrix.availability,
        holdingsText: holdingsTextOf(holdings),
      },
    });
  }

  // 3) 编号配不上：在同一字盘内找同字符同字体的字模（疑似改号）
  //    先看申报格位，再看盘内唯一候选；多个候选无法判定，按档案查无此模处理
  const declaredMatrix = declaredSlot
    ? matrices.find((m) => m.id === declaredSlot.matrixId)
    : undefined;
  const sameCharFontInCase = Array.from(
    new Set(
      typeCase.slots
        .map((s) => matrices.find((m) => m.id === s.matrixId))
        .filter((m): m is TypeMatrix => m !== undefined)
        .filter((m) => m.character === row.character && m.font === row.font)
        .map((m) => m.id),
    ),
  );
  const candidate =
    declaredMatrix && declaredMatrix.character === row.character && declaredMatrix.font === row.font
      ? declaredMatrix
      : sameCharFontInCase.length === 1
        ? matrices.find((m) => m.id === sameCharFontInCase[0])
        : undefined;
  if (candidate) {
    const candidateSlots = holdingsOf(cases, candidate.id);
    const atDeclared = candidateSlots.some(
      (h) => h.typeCase.id === typeCase.id && h.slots.some((s) => s.row === rc.row && s.col === rc.col),
    );
    const whereText = atDeclared
      ? `格位 ${positionLabel(rc.row, rc.col)} 上`
      : `盘内（${holdingsTextOf(candidateSlots).join('、')}）`;
    return buildItem('renumbered', row, {
      status: 'proposed',
      decision: 'accept-renumber',
      message: `回执编号 ${row.code} 在档案中不存在；${whereText}是 ${candidate.code}（${candidate.character}·${candidate.font}），字符字体一致，疑似改号`,
      options: ['accept-renumber', 'keep-code'],
      proposedAction: {
        decision: 'accept-renumber',
        matrixPatch: { matrixId: candidate.id, code: row.code.trim() },
        ...(atDeclared ? {} : { place: moveAction(candidate, typeCase, row) }),
      },
      snapshot: {
        matrixId: candidate.id,
        caseId: typeCase.id,
        matrixCode: candidate.code,
        matrixCharacter: candidate.character,
        matrixFont: candidate.font,
        matrixAvailability: candidate.availability,
        holdingsText: holdingsTextOf(candidateSlots),
      },
    });
  }

  // 4) 盘里有档案找不到的字模
  return buildItem('unknown-matrix', row, {
    status: 'pending',
    message: `字盘 ${typeCase.code} ${positionLabel(rc.row, rc.col)} 的字模编号 ${row.code} 在档案中查无此模${
      declaredSlot ? `（该格档案登记为 ${declaredSlot.character}）` : '（该格档案为空）'
    }`,
    options: ['register-new', 'ignore'],
    snapshot: {
      caseId: typeCase.id,
      holdingsText: [],
    },
  });
}

/** 整份回执核对（按行序处理，保留进度） */
export function analyzeRows(rows: ReceiptRow[], ctx: AnalyzeContext): ReconItem[] {
  const localCtx: AnalyzeContext = { ...ctx, doubledEmitted: ctx.doubledEmitted ?? new Set<string>() };
  const items: ReconItem[] = [];
  for (const row of rows) {
    const item = analyzeRow(row, localCtx);
    if (item) items.push(item);
  }
  return items;
}

/** 同一格位在回执中出现多次的行键（供界面提示） */
export function receiptDuplicateKeys(rows: ReceiptRow[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  rows.forEach((r) => {
    if (!r.rc || !r.caseCode) return;
    const key = `${r.caseCode.trim()}@${rcKey(r.rc.row, r.rc.col)}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n >= 2) out.set(key, key);
  });
  return out;
}
