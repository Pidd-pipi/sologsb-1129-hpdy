/**
 * 盘点对账引擎（纯函数）：
 * 先按字模编号配对；编号对不上（改号）时按字符、字体与盘内格位确认。
 * 同一枚字模占两个格位、盘里有档案找不到的字模、字模已停用 → 列待裁定。
 * 确认前不改档案；确认后由 store 事务性写入字模、落位与缺损记录。
 */
import type { CaseSlot, TypeCase } from '../types/case';
import type { DefectLog } from '../types/defect';
import type { MatrixFont, TypeMatrix } from '../types/matrix';
import type {
  MatchBy,
  Receipt,
  ReceiptLine,
  ReceiptLineInput,
  ReconcileAction,
  ReconciliationDecision,
  ReconciliationRecord,
} from '../types/receipt';
import { placeSlot, rcKey, removeSlot } from './layout';
import { makeId, todayStr } from './format';

export interface ReconcileContext {
  matrices: TypeMatrix[];
  cases: TypeCase[];
  defects: DefectLog[];
}

export interface LineResult {
  line: ReceiptLine;
  matchedMatrix: TypeMatrix | null;
  matchBy: MatchBy;
  category: '一致' | '待裁定';
  reason: string;
  action: ReconcileAction;
  decision: ReconciliationDecision;
}

/** 格位文字标签，例：B3 */
export function slotLabel(row: number, col: number): string {
  return `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[row] ?? row + 1}${col + 1}`;
}

function findByCode(matrices: TypeMatrix[], code: string): TypeMatrix | null {
  const c = code.trim();
  if (!c) return null;
  return matrices.find((m) => m.code.trim() === c) ?? null;
}

function findCaseByCode(cases: TypeCase[], code: string): TypeCase | null {
  const c = code.trim();
  if (!c) return null;
  return cases.find((x) => x.code.trim() === c) ?? null;
}

function findByCharFont(
  matrices: TypeMatrix[],
  character: string,
  font: string,
): TypeMatrix[] {
  const ch = character.trim();
  if (!ch) return [];
  return matrices.filter(
    (m) => m.character === ch && (!font || m.font === font),
  );
}

/** 字模当前在档案中的落位（任一字盘） */
function placementOf(
  cases: TypeCase[],
  matrixId: string,
): { typeCase: TypeCase; slot: CaseSlot } | null {
  for (const c of cases) {
    const slot = c.slots.find((s) => s.matrixId === matrixId);
    if (slot) return { typeCase: c, slot };
  }
  return null;
}

/** 在指定字盘的指定格位落位（返回新 slots，不改入参） */
function buildPlacement(
  typeCase: TypeCase,
  matrix: TypeMatrix,
  row: number,
  col: number,
): CaseSlot[] {
  const slot: CaseSlot = {
    row,
    col,
    character: matrix.character,
    matrixId: matrix.id,
    placedAt: new Date().toISOString(),
  };
  return placeSlot(typeCase.slots, slot);
}

/** 把字模从指定字盘的所有格位移除（返回新 slots） */
function buildRemoval(typeCase: TypeCase, matrixId: string): CaseSlot[] {
  return typeCase.slots.filter((s) => s.matrixId !== matrixId);
}

/** 停用 / 待补刻字模的补登缺损记录 */
function buildDefectInput(matrix: TypeMatrix): ReconciliationDecision['defectInput'] {
  const availability = matrix.availability === '待补刻' ? '待补刻' : '停用';
  return {
    matrixId: matrix.id,
    defectType: matrix.availability === '待补刻' ? '变形' : '磨损',
    severity: '中',
    foundDate: todayStr(),
    handling:
      availability === '待补刻'
        ? '盘点对账发现字模待补刻，补登缺损原因并核对落位'
        : '盘点对账发现字模停用，补登缺损原因并核对落位',
    availability,
    operator: '',
    note: '盘点对账补登',
  };
}

function reconcileLine(line: ReceiptLine, ctx: ReconcileContext): LineResult {
  const targetCase = findCaseByCode(ctx.cases, line.caseCode);
  const byCode = findByCode(ctx.matrices, line.code);

  if (byCode) {
    // 按编号配对成功 → 按字符、字体、盘内格位确认
    const charOk = byCode.character === line.character.trim();
    const fontOk = !line.font || byCode.font === line.font;
    const placement = placementOf(ctx.cases, byCode.id);
    const posOk =
      placement !== null &&
      targetCase !== null &&
      placement.typeCase.id === targetCase.id &&
      placement.slot.row === line.row &&
      placement.slot.col === line.col;

    if (charOk && fontOk && posOk) {
      return {
        line,
        matchedMatrix: byCode,
        matchBy: 'code',
        category: '一致',
        reason: '',
        action: 'none',
        decision: {},
      };
    }

    const reasons: string[] = [];
    let action: ReconcileAction = 'none';
    const decision: ReconciliationDecision = {};

    if (!charOk) {
      reasons.push(`字符不符（档案为「${byCode.character}」，回执为「${line.character}」）`);
      action = 'update-matrix';
      decision.matrixPatch = { character: line.character.trim() };
    }
    if (!fontOk) {
      reasons.push(`字体不符（档案为${byCode.font}，回执为${line.font}）`);
      action = 'update-matrix';
      decision.matrixPatch = { ...(decision.matrixPatch ?? {}), font: line.font as MatrixFont };
    }
    if (!posOk) {
      if (!targetCase) {
        reasons.push(`字盘「${line.caseCode}」在档案中不存在，无法核对格位`);
      } else {
        const archivePos = placement
          ? `${placement.typeCase.code} ${slotLabel(placement.slot.row, placement.slot.col)}`
          : '未落位';
        reasons.push(`格位不符（档案在${archivePos}，回执为${targetCase.code} ${slotLabel(line.row, line.col)}）`);
        if (action === 'none') action = 'update-placement';
        decision.placementPatch = {
          caseId: targetCase.id,
          slots: buildPlacement(targetCase, byCode, line.row, line.col),
        };
      }
    }

    return {
      line,
      matchedMatrix: byCode,
      matchBy: 'code',
      category: '待裁定',
      reason: reasons.join('；'),
      action,
      decision,
    };
  }

  // 编号对不上（改号）→ 按字符、字体与盘内格位确认
  const candidates = findByCharFont(ctx.matrices, line.character, line.font);
  const posMatches = candidates.filter((m) => {
    const p = placementOf(ctx.cases, m.id);
    return (
      p !== null &&
      targetCase !== null &&
      p.typeCase.id === targetCase.id &&
      p.slot.row === line.row &&
      p.slot.col === line.col
    );
  });
  const pool = posMatches.length > 0 ? posMatches : candidates;

  if (pool.length === 1) {
    const m = pool[0];
    const decision: ReconciliationDecision = {
      matrixPatch: { code: line.code.trim() },
    };
    if (targetCase) {
      const p = placementOf(ctx.cases, m.id);
      const posOk =
        p !== null &&
        p.typeCase.id === targetCase.id &&
        p.slot.row === line.row &&
        p.slot.col === line.col;
      if (!posOk) {
        decision.placementPatch = {
          caseId: targetCase.id,
          slots: buildPlacement(targetCase, m, line.row, line.col),
        };
      }
    }
    return {
      line,
      matchedMatrix: m,
      matchBy: 'char-font-position',
      category: '待裁定',
      reason: `编号已改（档案编号 ${m.code}），按字符 / 字体 / 格位配对为同一枚字模`,
      action: 'update-matrix',
      decision,
    };
  }

  if (pool.length === 0) {
    // 档案中找不到该字模
    const decision: ReconciliationDecision = {
      newMatrixInput: {
        code: line.code.trim(),
        character: line.character.trim(),
        font: (line.font || '宋体') as MatrixFont,
      },
    };
    if (targetCase) {
      decision.placementRequest = { caseId: targetCase.id, row: line.row, col: line.col };
    }
    return {
      line,
      matchedMatrix: null,
      matchBy: 'none',
      category: '待裁定',
      reason: `档案中找不到该字模（编号 ${line.code}，字符「${line.character}」）`,
      action: 'create-matrix',
      decision,
    };
  }

  // 多义：按字符 / 字体找到多枚，无法唯一确认
  return {
    line,
    matchedMatrix: null,
    matchBy: 'none',
    category: '待裁定',
    reason: `按字符 / 字体找到 ${pool.length} 枚字模（${pool
      .map((m) => m.code)
      .join('、')}），无法唯一确认`,
    action: 'none',
    decision: {},
  };
}

/** 整回执对账：逐行核对后，追加占两位 / 已停用两类待裁定 */
export function reconcileReceipt(receipt: Receipt, ctx: ReconcileContext): LineResult[] {
  const results = receipt.lines.map((line) => reconcileLine(line, ctx));

  // 同一枚字模占两个格位：回执中同字模出现在两个不同格位
  const byMatrix = new Map<string, number[]>();
  results.forEach((r, i) => {
    if (r.matchedMatrix) {
      const arr = byMatrix.get(r.matchedMatrix.id) ?? [];
      arr.push(i);
      byMatrix.set(r.matchedMatrix.id, arr);
    }
  });
  byMatrix.forEach((indices) => {
    const positions = new Set(
      indices.map((i) => `${results[i].line.caseCode}-${rcKey(results[i].line.row, results[i].line.col)}`),
    );
    if (positions.size <= 1) return;
    indices.forEach((i) => {
      const r = results[i];
      const posText = [...positions].map((p) => p.replace('-', ' ')).join('、');
      if (r.category === '待裁定') {
        r.reason = `同一枚字模占两个格位；${r.reason}`;
      } else {
        r.category = '待裁定';
        r.reason = `同一枚字模占两个格位（回执同时报在 ${posText}）`;
        r.action = 'update-placement';
        const targetCase = findCaseByCode(ctx.cases, r.line.caseCode);
        if (targetCase && r.matchedMatrix) {
          r.decision.placementPatch = {
            caseId: targetCase.id,
            slots: buildPlacement(targetCase, r.matchedMatrix, r.line.row, r.line.col),
          };
        }
      }
    });
  });

  // 字模已停用 / 待补刻 → 待裁定；停用字模不应留在盘内，动作以登记缺损并移除落位为准
  results.forEach((r) => {
    if (!r.matchedMatrix) return;
    if (r.matchedMatrix.availability === '可用') return;
    if (r.category === '一致') {
      r.category = '待裁定';
      r.reason = `字模已${r.matchedMatrix.availability}`;
    } else {
      r.reason = `字模已${r.matchedMatrix.availability}；${r.reason}`;
    }
    r.action = 'add-defect';
    r.decision.defectInput = buildDefectInput(r.matchedMatrix);
    // 停用 / 待补刻字模不应留在排字盘：当前在架则移除，不在架则清除误设的落位补丁
    const p = placementOf(ctx.cases, r.matchedMatrix.id);
    if (p) {
      r.decision.placementPatch = {
        caseId: p.typeCase.id,
        slots: buildRemoval(p.typeCase, r.matchedMatrix.id),
      };
    } else {
      delete r.decision.placementPatch;
    }
  });

  return results;
}

/** 由对账结果生成落库记录（不含裁定状态） */
export function buildRecords(
  receipt: Receipt,
  results: LineResult[],
): ReconciliationRecord[] {
  const now = new Date().toISOString();
  return results.map((r) => ({
    id: makeId('rec'),
    receiptId: receipt.id,
    receiptCode: receipt.code,
    lineId: r.line.id,
    matchedMatrixId: r.matchedMatrix?.id ?? '',
    matchBy: r.matchBy,
    category: r.category,
    reason: r.reason,
    verdict: 'pending' as const,
    action: r.action,
    decision: r.decision,
    resolvedAt: '',
    resolvedBy: '',
    createdAt: now,
    updatedAt: now,
  }));
}

/** 统计对账结果 */
export function summarizeResults(records: ReconciliationRecord[]): {
  total: number;
  consistent: number;
  pending: number;
  confirmed: number;
  rejected: number;
} {
  const out = { total: records.length, consistent: 0, pending: 0, confirmed: 0, rejected: 0 };
  for (const r of records) {
    if (r.category === '一致') out.consistent += 1;
    else if (r.verdict === 'pending') out.pending += 1;
    else if (r.verdict === 'confirmed') out.confirmed += 1;
    else if (r.verdict === 'rejected') out.rejected += 1;
  }
  return out;
}

/** 解析一行回执文本：编号,字符,字体,字盘,行,列 */
export function parseReceiptLine(text: string): ReceiptLineInput | null {
  const parts = text.split(/[,，\t]/).map((s) => s.trim());
  if (parts.length < 6) return null;
  const [code, character, font, caseCode, rowText, colText] = parts;
  const row = Number(rowText);
  const col = Number(colText);
  if (!code || !character || !caseCode) return null;
  if (!Number.isInteger(row) || row < 1 || !Number.isInteger(col) || col < 1) return null;
  return { code, character, font, caseCode, row: row - 1, col: col - 1 };
}

export function lineInputToLine(input: ReceiptLineInput): ReceiptLine {
  return {
    id: makeId('ln'),
    code: input.code,
    character: input.character,
    font: (input.font || '') as MatrixFont | '',
    caseCode: input.caseCode,
    row: input.row,
    col: input.col,
  };
}
