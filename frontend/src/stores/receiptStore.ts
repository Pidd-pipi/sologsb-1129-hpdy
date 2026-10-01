/**
 * 盘点对账状态：回执与对账结果持久化在 IndexedDB。
 * - 导入失败也留下回执与进度（回执先落库，再跑核对）
 * - 恢复后接着核对（记录随回执持久化）
 * - 同一回执再次提交不重复生成结果（按回执编号去重）
 * - 裁定确认后事务性更新字模、落位与缺损记录；试印记录原样保留
 */
import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { CaseSlot, TypeCase } from '../types/case';
import { matrixIdsOf } from '../utils/layout';
import type { DefectLog } from '../types/defect';
import type { MatrixFont, TypeMatrix } from '../types/matrix';
import { ptOfSize } from '../types/matrix';
import type {
  Receipt,
  ReceiptLine,
  ReconciliationRecord,
} from '../types/receipt';
import {
  buildRecords,
  reconcileReceipt,
  type LineResult,
} from '../utils/reconcile';
import { makeId, toPlain } from '../utils/format';

interface ImportInput {
  code: string;
  source: string;
  receiptDate: string;
  note: string;
  lines: ReceiptLine[];
}

interface ReceiptState {
  receipts: Receipt[];
  records: ReconciliationRecord[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  /** 导入回执并核对；同编号回执已存在时直接载入旧结果（duplicated=true），不重复生成 */
  importReceipt: (input: ImportInput) => Promise<{
    receipt: Receipt;
    records: ReconciliationRecord[];
    duplicated: boolean;
  }>;
  /** 对已有回执重新核对（覆盖旧的待裁定记录，保留已裁定结果） */
  rerunReconcile: (receiptId: string) => Promise<void>;
  /** 确认一条待裁定：按决策更新字模 / 落位 / 缺损记录 */
  confirmVerdict: (recordId: string, operator: string) => Promise<void>;
  /** 驳回一条待裁定：维持档案不变 */
  rejectVerdict: (recordId: string) => Promise<void>;
}

function byUpdatedDesc(a: Receipt, b: Receipt): number {
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/** 读取核对所需的档案上下文 */
async function loadContext() {
  const [matrices, cases, defects] = await Promise.all([
    db.matrices.toArray(),
    db.cases.toArray(),
    db.defects.toArray(),
  ]);
  return { matrices, cases, defects };
}

/** 把对账结果落库（事务内调用） */
async function persistResults(
  receiptId: string,
  receiptCode: string,
  results: LineResult[],
  now: string,
) {
  const fresh = buildRecords(
    { id: receiptId, code: receiptCode } as Receipt,
    results,
  );
  await db.reconciliations.bulkPut(toPlain(fresh));
  return fresh;
}

export const useReceiptStore = create<ReceiptState>((set, get) => ({
  receipts: [],
  records: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [receipts, records] = await Promise.all([
        db.receipts.toArray(),
        db.reconciliations.toArray(),
      ]);
      set({
        receipts: receipts.sort(byUpdatedDesc),
        records,
        loaded: true,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '对账档案读取失败',
      });
    }
  },

  importReceipt: async (input) => {
    const code = input.code.trim();
    if (!code) throw new Error('回执编号不能为空');
    if (input.lines.length === 0) throw new Error('回执至少要有一行字模记录');

    // 同一回执再次提交：载入旧结果，不重复生成
    const existing = await db.receipts.where('code').equals(code).first();
    if (existing) {
      const oldRecords = await db.reconciliations
        .where('receiptId')
        .equals(existing.id)
        .toArray();
      set((s) => ({
        receipts: [existing, ...s.receipts.filter((r) => r.id !== existing.id)].sort(byUpdatedDesc),
        records: [...oldRecords, ...s.records.filter((r) => r.receiptId !== existing.id)],
      }));
      return { receipt: existing, records: oldRecords, duplicated: true };
    }

    const now = new Date().toISOString();
    const receipt: Receipt = toPlain({
      id: makeId('rcp'),
      code,
      source: input.source.trim(),
      receiptDate: input.receiptDate,
      note: input.note.trim(),
      lines: input.lines,
      status: '待核对' as const,
      createdAt: now,
      updatedAt: now,
    });

    // 先落库回执：即使后续核对失败，回执与进度也还在
    await db.receipts.add(receipt);
    set((s) => ({ receipts: [receipt, ...s.receipts] }));

    try {
      const ctx = await loadContext();
      const results = reconcileReceipt(receipt, ctx);
      const records = await persistResults(receipt.id, receipt.code, results, now);
      const hasPending = records.some((r) => r.category === '待裁定' && r.verdict === 'pending');
      const status: Receipt['status'] = hasPending ? '核对中' : '已完成';
      await db.receipts.update(receipt.id, { status, updatedAt: new Date().toISOString() });
      set((s) => ({
        receipts: s.receipts.map((r) =>
          r.id === receipt.id ? { ...r, status, updatedAt: new Date().toISOString() } : r,
        ),
        records: [...records, ...s.records.filter((r) => r.receiptId !== receipt.id)],
      }));
      return { receipt, records, duplicated: false };
    } catch (err) {
      // 核对失败：回执保留为「待核对」，恢复后可重新核对
      set((s) => ({
        receipts: s.receipts.map((r) =>
          r.id === receipt.id ? { ...r, status: '待核对' } : r,
        ),
      }));
      throw err instanceof Error ? err : new Error('核对失败，回执已保留，可稍后重新核对');
    }
  },

  rerunReconcile: async (receiptId) => {
    const receipt = await db.receipts.get(receiptId);
    if (!receipt) throw new Error('未找到回执');
    const ctx = await loadContext();
    const results = reconcileReceipt(receipt, ctx);
    const fresh = buildRecords(receipt, results);

    // 保留已裁定结果（按 lineId 匹配），仅覆盖未裁定的
    const oldRecords = await db.reconciliations
      .where('receiptId')
      .equals(receiptId)
      .toArray();
    const resolvedByLine = new Map(
      oldRecords
        .filter((r) => r.verdict !== 'pending')
        .map((r) => [r.lineId, r]),
    );
    const merged = fresh.map((r) => resolvedByLine.get(r.lineId) ?? r);

    await db.transaction('rw', db.receipts, db.reconciliations, async () => {
      await db.reconciliations.bulkPut(toPlain(merged));
      const hasPending = merged.some((r) => r.category === '待裁定' && r.verdict === 'pending');
      await db.receipts.update(receiptId, {
        status: hasPending ? '核对中' : '已完成',
        updatedAt: new Date().toISOString(),
      });
    });

    set((s) => ({
      receipts: s.receipts.map((r) =>
        r.id === receiptId
          ? { ...r, status: merged.some((x) => x.category === '待裁定' && x.verdict === 'pending') ? '核对中' : '已完成' }
          : r,
      ),
      records: [...merged, ...s.records.filter((r) => r.receiptId !== receiptId)],
    }));
  },

  confirmVerdict: async (recordId, operator) => {
    const record = await db.reconciliations.get(recordId);
    if (!record) throw new Error('未找到对账记录');
    if (record.verdict !== 'pending') return;

    const now = new Date().toISOString();
    const op = operator.trim() || '馆员';
    const decision = record.decision ?? {};

    await db.transaction(
      'rw',
      db.matrices,
      db.cases,
      db.defects,
      db.reconciliations,
      async () => {
        let matrixId = record.matchedMatrixId;

        // 新建字模（档案中找不到）
        if (record.action === 'create-matrix' && decision.newMatrixInput) {
          const input = decision.newMatrixInput;
          const row: TypeMatrix = toPlain({
            id: makeId('mtx'),
            code: input.code,
            character: input.character,
            font: input.font,
            sizeName: '五号',
            sizePt: ptOfSize('五号'),
            material: '铅合金',
            faceWidthMm: 3.7,
            bodyHeightMm: 5.6,
            madeYear: new Date().getFullYear(),
            engraver: '盘点补录',
            availability: '可用' as const,
            note: '盘点对账补录字模',
            createdAt: now,
            updatedAt: now,
          });
          await db.matrices.add(row);
          matrixId = row.id;

          // 新建后落到指定格位
          if (decision.placementRequest) {
            const c = await db.cases.get(decision.placementRequest.caseId);
            if (c) {
              const slot: CaseSlot = {
                row: decision.placementRequest.row,
                col: decision.placementRequest.col,
                character: row.character,
                matrixId: row.id,
                placedAt: now,
              };
              const slots = [...c.slots.filter((s) => !(s.row === slot.row && s.col === slot.col)), slot];
              await db.cases.update(c.id, {
                slots,
                matrixId: matrixIdsOf(slots),
                updatedAt: now,
              });
            }
          }
        }

        // 更新字模档案（编号 / 字符 / 字体）
        if (matrixId && decision.matrixPatch) {
          const patch: Partial<TypeMatrix> = { ...decision.matrixPatch, updatedAt: now };
          if (patch.sizeName) patch.sizePt = ptOfSize(patch.sizeName);
          await db.matrices.update(matrixId, patch);

          // 字符变更时，同步更新所有字盘格位上冗余的字符
          if (decision.matrixPatch.character) {
            const allCases = await db.cases.toArray();
            for (const c of allCases) {
              let changed = false;
              const slots = c.slots.map((s) => {
                if (s.matrixId === matrixId) {
                  changed = true;
                  return { ...s, character: decision.matrixPatch!.character! };
                }
                return s;
              });
              if (changed) {
                await db.cases.update(c.id, { slots, updatedAt: now });
              }
            }
          }
        }

        // 落位调整（已存在字模的格位更正 / 停用移除）
        if (matrixId && decision.placementPatch) {
          const { caseId, slots } = decision.placementPatch;
          const c = await db.cases.get(caseId);
          if (c) {
            await db.cases.update(c.id, {
              slots: toPlain(slots),
              matrixId: matrixIdsOf(slots),
              updatedAt: now,
            });
          }
        }

        // 新增缺损记录（字模已停用 / 待补刻）
        if (matrixId && decision.defectInput) {
          const matrix = await db.matrices.get(matrixId);
          const defect: DefectLog = toPlain({
            id: makeId('dft'),
            matrixId,
            character: matrix?.character ?? '',
            matrixCode: matrix?.code ?? '',
            defectType: decision.defectInput.defectType,
            severity: decision.defectInput.severity,
            foundDate: decision.defectInput.foundDate,
            handling: decision.defectInput.handling,
            availability: decision.defectInput.availability,
            operator: op,
            note: decision.defectInput.note ?? '盘点对账补登',
            createdAt: now,
          });
          await db.defects.add(defect);
          // 确保字模为停用 / 待补刻状态
          await db.matrices.update(matrixId, {
            availability: decision.defectInput.availability,
            updatedAt: now,
          });
        }

        // 标记本条记录已确认
        await db.reconciliations.update(recordId, {
          verdict: 'confirmed',
          resolvedAt: now,
          resolvedBy: op,
          updatedAt: now,
        });

        // 占两位：确认一个格位后，自动驳回同字模的其他待裁定落位记录
        if (matrixId) {
          const siblings = await db.reconciliations
            .where('matchedMatrixId')
            .equals(matrixId)
            .toArray();
          for (const sib of siblings) {
            if (sib.id === recordId) continue;
            if (sib.receiptId !== record.receiptId) continue;
            if (sib.verdict !== 'pending') continue;
            if (sib.category !== '待裁定') continue;
            await db.reconciliations.update(sib.id, {
              verdict: 'rejected',
              resolvedAt: now,
              resolvedBy: `${op}（占两位，已按确认格位为准）`,
              updatedAt: now,
            });
          }
        }
      },
    );

    // 试印记录原样保留：本事务不触碰 proofs 表
    set((s) => ({
      records: s.records.map((r) => {
        if (r.id === recordId) {
          return { ...r, verdict: 'confirmed', resolvedAt: now, resolvedBy: op, updatedAt: now };
        }
        return r;
      }),
    }));
    // 重新读回，确保字模 / 落位 / 缺损的联动更新反映到界面
    await get().rerunReconcile(record.receiptId).catch(() => undefined);
  },

  rejectVerdict: async (recordId) => {
    const record = await db.reconciliations.get(recordId);
    if (!record) throw new Error('未找到对账记录');
    if (record.verdict !== 'pending') return;
    const now = new Date().toISOString();
    await db.reconciliations.update(recordId, {
      verdict: 'rejected',
      resolvedAt: now,
      resolvedBy: '馆员（维持档案）',
      updatedAt: now,
    });
    set((s) => ({
      records: s.records.map((r) =>
        r.id === recordId
          ? { ...r, verdict: 'rejected', resolvedAt: now, resolvedBy: '馆员（维持档案）', updatedAt: now }
          : r,
      ),
    }));
  },
}));

/** 某回执的对账记录（按行顺序） */
export function recordsOfReceipt(records: ReconciliationRecord[], receiptId: string) {
  return records
    .filter((r) => r.receiptId === receiptId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
