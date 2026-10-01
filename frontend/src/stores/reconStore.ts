import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import { useCaseStore } from './caseStore';
import { useMatrixStore } from './matrixStore';
import type { CaseSlot, TypeCase } from '../types/case';
import type { DefectLog } from '../types/defect';
import type { MatrixFont, TypeMatrix } from '../types/matrix';
import { MATRIX_FONTS, ptOfSize } from '../types/matrix';
import type {
  ReconBatch,
  ReconItem,
  ReconItemKind,
  ReconItemStatus,
} from '../types/reconcile';
import { summarizeItems } from '../types/reconcile';
import { makeId, toPlain, todayStr } from '../utils/format';
import { matrixIdsOf } from '../utils/layout';
import { analyzeRow } from '../utils/reconcile';
import { hashReceipt, parseReceipt } from '../utils/receipt';

/** 车间回执盘点对账：导入核对（可断点续核）→ 馆员裁定 → 一次性落账 */

const CHUNK_SIZE = 25;

/** 补登记新字模所需的额外字段（编号 / 字符 / 字体取自回执） */
export interface RegisterPayload {
  sizeName: string;
  material: TypeMatrix['material'];
}

export interface ImportReceiptResult {
  batch: ReconBatch;
  /** 同一份回执再次提交时为 true，直接复用既有批次，不重复生成结果 */
  duplicated: boolean;
}

export interface ApplySummary {
  matricesUpdated: number;
  matricesCreated: number;
  casesUpdated: number;
  defectsAdded: number;
}

interface ReconState {
  batches: ReconBatch[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  importReceipt: (rawText: string, fileName: string) => Promise<ImportReceiptResult>;
  continueBatch: (id: string) => Promise<void>;
  resolveItem: (
    batchId: string,
    itemId: string,
    decision: string,
    register?: RegisterPayload,
  ) => Promise<void>;
  applyBatch: (id: string, operator?: string) => Promise<ApplySummary>;
  removeBatch: (id: string) => Promise<void>;
  clearApplied: () => Promise<void>;
}

/** 依据条目状态推导批次状态 */
function deriveStatus(items: ReconItem[]): ReconBatch['status'] {
  return summarizeItems(items).hasOpen ? 'pending' : 'ready';
}

function defaultBatchName(rows: ReturnType<typeof parseReceipt>, stamp: string): string {
  const firstCase = rows.find((r) => r.caseCode)?.caseCode ?? '未注明字盘';
  const d = new Date(stamp);
  const p = (n: number) => `${n}`.padStart(2, '0');
  return `回执-${firstCase}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 对一批回执行做分块核对，逐块落进度；可从 processedRows 断点继续 */
async function runAnalysis(batch: ReconBatch, onProgress?: (b: ReconBatch) => void): Promise<void> {
  const rows = parseReceipt(batch.rawText);
  let cursor = batch.processedRows;
  // 已提示过「一枚双格」的字模，续核时从既有条目恢复
  const doubledEmitted = new Set(
    batch.items.filter((i) => i.kind === 'double-slot').map((i) => i.snapshot.matrixId ?? ''),
  );

  while (cursor < rows.length) {
    // 每块开始前重新读库，保证核对用的是最新档案
    const [matrices, cases] = await Promise.all([db.matrices.toArray(), db.cases.toArray()]);
    const end = Math.min(cursor + CHUNK_SIZE, rows.length);
    const newItems: ReconItem[] = [];
    for (let i = cursor; i < end; i += 1) {
      const item = analyzeRow(rows[i], { matrices, cases, doubledEmitted });
      if (item) newItems.push(item);
    }
    cursor = end;
    const current = await db.reconBatches.get(batch.id);
    if (!current) throw new Error('核对批次已被删除');
    const items = [...current.items, ...newItems];
    const progressStamp = new Date().toISOString();
    await db.reconBatches.update(batch.id, {
      items: toPlain(items),
      processedRows: cursor,
      status: 'analyzing',
      updatedAt: progressStamp,
    });
    batch.items = items;
    batch.processedRows = cursor;
    batch.status = 'analyzing';
    batch.updatedAt = progressStamp;
    // 若最终状态已先写入（续核到末块时可能发生），不用进度覆盖
    const latest = await db.reconBatches.get(batch.id);
    if (latest?.status === 'analyzing') onProgress?.(batch);
    // 让出主线程，便于界面刷新进度
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const finished = await db.reconBatches.get(batch.id);
  if (!finished) throw new Error('核对批次已被删除');
  const status = deriveStatus(finished.items);
  const stamp = new Date().toISOString();
  await db.reconBatches.update(batch.id, {
    status,
    errorMessage: '',
    updatedAt: stamp,
  });
  batch.status = status;
  batch.errorMessage = '';
  batch.updatedAt = stamp;
}

export const useReconStore = create<ReconState>((set, get) => ({
  batches: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const batches = await db.reconBatches.toArray();
      set({
        batches: batches.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
        loaded: true,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '盘点批次读取失败' });
    }
  },

  importReceipt: async (rawText, fileName) => {
    await ensureSeed();
    const contentHash = hashReceipt(rawText);
    const existing = await db.reconBatches.where('contentHash').equals(contentHash).first();
    if (existing) {
      return { batch: existing, duplicated: true };
    }

    const stamp = new Date().toISOString();
    const rows = parseReceipt(rawText);
    const batch: ReconBatch = {
      id: makeId('rcnb'),
      name: defaultBatchName(rows, stamp),
      fileName: fileName.trim() || '粘贴回执',
      rawText,
      contentHash,
      status: rows.length === 0 ? 'failed' : 'analyzing',
      items: [],
      processedRows: 0,
      totalRows: rows.length,
      errorMessage: rows.length === 0 ? '回执内容为空或无法识别，请检查分隔符（制表符或逗号）与表头' : '',
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.reconBatches.add(toPlain(batch));
    set((s) => ({ batches: [batch, ...s.batches] }));

    if (rows.length > 0) {
      try {
        await runAnalysis(batch, (b) => {
          set((s) => ({ batches: s.batches.map((x) => (x.id === b.id ? { ...b } : x)) }));
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '核对中断';
        await db.reconBatches.update(batch.id, {
          status: 'failed',
          errorMessage: message,
          updatedAt: new Date().toISOString(),
        });
        batch.status = 'failed';
        batch.errorMessage = message;
      }
    }

    const saved = (await db.reconBatches.get(batch.id))!;
    set((s) => ({
      batches: s.batches.map((b) => (b.id === saved.id ? saved : b)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    }));
    return { batch: saved, duplicated: false };
  },

  /** 失败 / 核对中断后接着核对：回执与进度都保留，从断点继续 */
  continueBatch: async (id) => {
    const batch = get().batches.find((b) => b.id === id);
    if (!batch) return;
    if (batch.status !== 'analyzing' && batch.status !== 'failed') return;
    await db.reconBatches.update(id, { status: 'analyzing', errorMessage: '', updatedAt: new Date().toISOString() });
    batch.status = 'analyzing';
    batch.errorMessage = '';
    try {
      await runAnalysis(batch, (b) => {
        set((s) => ({ batches: s.batches.map((x) => (x.id === id ? { ...b } : x)) }));
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '核对中断';
      batch.status = 'failed';
      batch.errorMessage = message;
      await db.reconBatches.update(id, {
        status: 'failed',
        errorMessage: message,
        updatedAt: new Date().toISOString(),
      });
    }
    const saved = await db.reconBatches.get(id);
    if (saved) {
      set((s) => ({
        batches: s.batches.map((b) => (b.id === id ? saved : b)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      }));
    }
  },

  resolveItem: async (batchId, itemId, decision, register) => {
    const batch = get().batches.find((b) => b.id === batchId);
    if (!batch) throw new Error('未找到核对批次');
    const item = batch.items.find((i) => i.id === itemId);
    if (!item) throw new Error('未找到核对条目');
    if (!item.options.includes(decision)) throw new Error('该条目不支持此处理决定');

    if (decision === 'register-new') {
      if (!register || !register.sizeName || !register.material) {
        throw new Error('补登记需要补全字号与材质');
      }
      if (!MATRIX_FONTS.includes(item.receipt.font as MatrixFont)) {
        throw new Error(`回执字体「${item.receipt.font}」不在登记范围（宋体 / 楷体 / 仿宋）`);
      }
      const code = item.receipt.code.trim();
      const dup = await db.matrices.filter((m) => m.code.trim() === code).first();
      if (dup) throw new Error(`编号 ${code} 已被字模 ${dup.character}（${dup.id}）占用`);
    }

    const ignored = decision === 'ignore' || decision === 'keep-placement' || decision === 'keep-code' || decision === 'reject-receipt';
    const status: ReconItemStatus = ignored ? 'ignored' : 'accepted';
    const items = batch.items.map((i) =>
      i.id === itemId
        ? {
            ...i,
            status,
            decision,
            resolvedAt: new Date().toISOString(),
            action: register
              ? {
                  decision,
                  register: {
                    code: item.receipt.code.trim(),
                    character: item.receipt.character,
                    font: item.receipt.font as MatrixFont,
                    sizeName: register.sizeName,
                    material: register.material,
                  },
                }
              : { decision },
          }
        : i,
    );
    const next = {
      ...batch,
      items,
      status: deriveStatus(items),
      updatedAt: new Date().toISOString(),
    };
    await db.reconBatches.put(toPlain(next));
    set((s) => ({
      batches: s.batches.map((b) => (b.id === batchId ? next : b)),
    }));
  },

  /** 馆员处理完后一次性落账：字模、落位、缺损记录同事务更新；试印记录原样保留 */
  applyBatch: async (id, operator = '盘点对账') => {
    const batch = get().batches.find((b) => b.id === id);
    if (!batch) throw new Error('未找到核对批次');
    if (batch.status !== 'ready') {
      throw new Error('仍有待裁定条目，请先全部处理后再落账');
    }

    const summary: ApplySummary = {
      matricesUpdated: 0,
      matricesCreated: 0,
      casesUpdated: 0,
      defectsAdded: 0,
    };

    await db.transaction(
      'rw',
      db.matrices,
      db.cases,
      db.defects,
      db.reconBatches,
      async () => {
        const matrices = await db.matrices.toArray();
        const cases = await db.cases.toArray();
        const matrixById = new Map(matrices.map((m) => [m.id, m]));
        const caseById = new Map(cases.map((c) => [c.id, c]));
        /** 统一以 map 为准，落库期间所有改动都反映在这一份对象上 */
        const allCases = () => Array.from(caseById.values());
        const touchedCases = new Set<string>();
        const touchedMatrices = new Set<string>();
        const newDefects: DefectLog[] = [];
        /** register-new 的条目临时 id → 新字模 id */
        const newMatrixIdByItem = new Map<string, string>();
        const stamp = new Date().toISOString();

        const touchCase = (caseId: string) => {
          const c = caseById.get(caseId);
          if (c) touchedCases.add(caseId);
        };

        const rebuildIndex = (c: TypeCase) => {
          c.matrixId = matrixIdsOf(c.slots);
        };

        const placeAt = (caseId: string, matrixId: string, character: string, row: number, col: number) => {
          const c = caseById.get(caseId);
          if (!c) return;
          c.slots = c.slots.filter((s) => !(s.row === row && s.col === col));
          const slot: CaseSlot = { row, col, character, matrixId, placedAt: stamp };
          c.slots = [...c.slots, slot].sort((a, b) => a.row - b.row || a.col - b.col);
          touchedCases.add(caseId);
        };

        const takeAt = (caseId: string, row: number, col: number) => {
          const c = caseById.get(caseId);
          if (!c) return;
          const before = c.slots.length;
          c.slots = c.slots.filter((s) => !(s.row === row && s.col === col));
          if (c.slots.length !== before) touchedCases.add(caseId);
        };

        const takeMatrixFromCase = (caseId: string, matrixId: string) => {
          const c = caseById.get(caseId);
          if (!c) return;
          const before = c.slots.length;
          c.slots = c.slots.filter((s) => s.matrixId !== matrixId);
          if (c.slots.length !== before) touchedCases.add(caseId);
        };

        const addDefect = (
          matrix: TypeMatrix,
          defectType: DefectLog['defectType'],
          severity: DefectLog['severity'],
          handling: string,
          availability: DefectLog['availability'],
        ) => {
          newDefects.push({
            id: makeId('dft'),
            matrixId: matrix.id,
            character: matrix.character,
            matrixCode: matrix.code,
            defectType,
            severity,
            foundDate: todayStr(),
            handling,
            availability,
            operator,
            note: `车间回执盘点（${batch.name}）`,
            createdAt: stamp,
          });
        };

        for (const item of batch.items) {
          if (item.status === 'ignored' || item.kind === 'matched') continue;
          if (item.status !== 'accepted') continue;
          const decision = item.decision;
          const rc = item.receipt.rc;
          const caseId = item.snapshot.caseId;
          const typeCase = caseId ? caseById.get(caseId) : undefined;

          if (item.kind === 'unknown-matrix' && decision === 'register-new') {
            if (!rc || !typeCase) throw new Error(`第 ${item.receipt.lineNo} 行：字盘或格位信息缺失，无法补登记落位`);
            const reg = item.action?.register;
            if (!reg) throw new Error(`第 ${item.receipt.lineNo} 行：缺少补登记信息`);
            const code = reg.code.trim();
            if (matrices.some((m) => m.code.trim() === code)) {
              throw new Error(`编号 ${code} 已存在，无法重复登记（第 ${item.receipt.lineNo} 行）`);
            }
            const id = makeId('mtx');
            const created: TypeMatrix = {
              id,
              code,
              character: reg.character,
              font: reg.font,
              sizeName: reg.sizeName,
              sizePt: ptOfSize(reg.sizeName),
              material: reg.material,
              faceWidthMm: 0,
              bodyHeightMm: 0,
              madeYear: new Date().getFullYear(),
              engraver: '',
              availability: '可用',
              note: `车间回执盘点补登记（批次 ${batch.name}），尺寸与刻工待补`,
              createdAt: stamp,
              updatedAt: stamp,
            };
            matrices.push(created);
            matrixById.set(id, created);
            newMatrixIdByItem.set(item.id, id);
            summary.matricesCreated += 1;
            placeAt(typeCase.id, id, created.character, rc.row, rc.col);
            continue;
          }

          const matrixId = item.snapshot.matrixId;
          const matrix = matrixId ? matrixById.get(matrixId) : undefined;
          if (!matrix) {
            throw new Error(`第 ${item.receipt.lineNo} 行：档案中已找不到对应字模，请重新核对该批次`);
          }
          if (!typeCase && (decision === 'accept-move' || decision === 'accept-renumber' || decision === 'accept-correction')) {
            throw new Error(`第 ${item.receipt.lineNo} 行：目标字盘已不存在，无法落位`);
          }

          switch (item.kind) {
            case 'slot-moved': {
              if (decision === 'accept-move' && rc && typeCase) {
                const here = typeCase.slots.filter(
                  (s) => s.matrixId === matrix.id && s.row === rc.row && s.col === rc.col,
                );
                if (here.length === 0) {
                  placeAt(typeCase.id, matrix.id, matrix.character, rc.row, rc.col);
                }
              }
              break;
            }
            case 'renumbered': {
              if (decision === 'accept-renumber') {
                const newCode = item.receipt.code.trim();
                const clash = matrices.find((m) => m.id !== matrix.id && m.code.trim() === newCode);
                if (clash) throw new Error(`编号 ${newCode} 与字模 ${clash.character}（${clash.code}）冲突`);
                matrix.code = newCode;
                matrix.updatedAt = stamp;
                touchedMatrices.add(matrix.id);
                if (rc && typeCase) {
                  const here = typeCase.slots.some(
                    (s) => s.matrixId === matrix.id && s.row === rc.row && s.col === rc.col,
                  );
                  if (!here) placeAt(typeCase.id, matrix.id, matrix.character, rc.row, rc.col);
                }
              }
              break;
            }
            case 'char-font-mismatch': {
              if (decision === 'accept-correction') {
                matrix.character = item.receipt.character;
                matrix.font = item.receipt.font as MatrixFont;
                matrix.updatedAt = stamp;
                touchedMatrices.add(matrix.id);
                if (rc && typeCase) placeAt(typeCase.id, matrix.id, matrix.character, rc.row, rc.col);
              }
              break;
            }
            case 'disabled-found': {
              if (decision === 'reactivate-keep') {
                matrix.availability = '可用';
                matrix.updatedAt = stamp;
                touchedMatrices.add(matrix.id);
                addDefect(matrix, '磨损', '轻', '车间盘点见在盘，复查后复置为可用', '可用');
              } else if (decision === 'deactivate-remove') {
                matrix.availability = '停用';
                matrix.updatedAt = stamp;
                touchedMatrices.add(matrix.id);
                addDefect(matrix, '磨损', '中', '车间盘点确认维持停用，已从字盘取出', '停用');
                for (const c of allCases()) takeMatrixFromCase(c.id, matrix.id);
              }
              break;
            }
            case 'double-slot': {
              if (!rc || !typeCase) throw new Error(`第 ${item.receipt.lineNo} 行：格位信息缺失`);
              if (decision === 'keep-declared') {
                // 以回执申报格位为准：先取净该字模全部落位，再落回申报格
                for (const c of allCases()) takeMatrixFromCase(c.id, matrix.id);
                placeAt(typeCase.id, matrix.id, matrix.character, rc.row, rc.col);
              } else if (decision === 'remove-all') {
                for (const c of allCases()) {
                  takeMatrixFromCase(c.id, matrix.id);
                  touchCase(c.id);
                }
              }
              break;
            }
            default:
              break;
          }
        }

        // 落库被改动的字模
        for (const id of touchedMatrices) {
          const m = matrixById.get(id);
          if (m) {
            await db.matrices.put(toPlain(m));
            summary.matricesUpdated += 1;
          }
        }
        // 落库新建字模
        for (const item of batch.items) {
          const newId = newMatrixIdByItem.get(item.id);
          if (newId) await db.matrices.put(toPlain(matrixById.get(newId)!));
        }
        // 落库被改动的字盘（重建 matrixId 索引）
        for (const caseId of touchedCases) {
          const c = caseById.get(caseId);
          if (!c) continue;
          rebuildIndex(c);
          c.updatedAt = stamp;
          await db.cases.put(toPlain(c));
          summary.casesUpdated += 1;
        }
        if (newDefects.length > 0) {
          await db.defects.bulkAdd(toPlain(newDefects));
          summary.defectsAdded = newDefects.length;
        }

        // 批次与条目标记已落账；既有试印记录不在本事务内，照原样保留
        const appliedItems = batch.items.map((i) =>
          i.status === 'accepted' ? { ...i, status: 'applied' as ReconItemStatus } : i,
        );
        await db.reconBatches.update(batch.id, {
          items: toPlain(appliedItems),
          status: 'applied' as const,
          appliedAt: stamp,
          updatedAt: stamp,
        });
      },
    );

    // 刷新内存中的字模 / 字盘档案
    await Promise.all([useMatrixStore.getState().load(), useCaseStore.getState().load()]);
    const saved = await db.reconBatches.get(id);
    if (saved) {
      set((s) => ({
        batches: s.batches.map((b) => (b.id === id ? saved : b)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      }));
    }
    return summary;
  },

  removeBatch: async (id) => {
    await db.reconBatches.delete(id);
    set((s) => ({ batches: s.batches.filter((b) => b.id !== id) }));
  },

  clearApplied: async () => {
    const applied = get().batches.filter((b) => b.status === 'applied');
    await Promise.all(applied.map((b) => db.reconBatches.delete(b.id)));
    set((s) => ({ batches: s.batches.filter((b) => b.status !== 'applied') }));
  },
}));

/** 条目类型在界面上的筛选顺序 */
export const RECON_KIND_ORDER: ReconItemKind[] = [
  'double-slot',
  'unknown-matrix',
  'char-font-mismatch',
  'disabled-found',
  'renumbered',
  'slot-moved',
  'unknown-case',
  'bad-row',
  'matched',
];
