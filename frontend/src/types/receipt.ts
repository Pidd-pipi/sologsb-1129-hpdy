/** 车间回执与盘点对账（Reconciliation） */
import type { CaseSlot } from './case';
import type { DefectInput } from './defect';
import type { MatrixFont, TypeMatrix } from './matrix';

/** 回执状态：待核对 / 核对中 / 已完成 */
export const RECEIPT_STATUSES = ['待核对', '核对中', '已完成'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** 对账结果分类：一致 / 待裁定 */
export const RECONCILE_CATEGORIES = ['一致', '待裁定'] as const;
export type ReconcileCategory = (typeof RECONCILE_CATEGORIES)[number];

/** 配对方式：按编号 / 按字符·字体·格位（改号后）/ 未配对 */
export const MATCH_BY = ['code', 'char-font-position', 'none'] as const;
export type MatchBy = (typeof MATCH_BY)[number];

/** 裁定状态：待裁定 / 已确认 / 已驳回 */
export const VERDICT_STATUSES = ['pending', 'confirmed', 'rejected'] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

/** 裁定后采取的动作 */
export const RECONCILE_ACTIONS = [
  'none',
  'update-matrix',
  'update-placement',
  'add-defect',
  'create-matrix',
] as const;
export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];

/** 回执一行：车间报来的一枚字模及其盘内格位（行、列均为 0 基） */
export interface ReceiptLine {
  id: string;
  /** 字模编号（回执上写的，可能与档案不同） */
  code: string;
  /** 字符 */
  character: string;
  /** 字体（回执未填时为空串） */
  font: MatrixFont | '';
  /** 字盘编号 */
  caseCode: string;
  /** 格位行（0 基） */
  row: number;
  /** 格位列（0 基） */
  col: number;
}

/** 车间回执：一次盘点对账的批次 */
export interface Receipt {
  id: string;
  /** 回执编号，例：HZ-20250601-01 */
  code: string;
  /** 车间来源，例：一号排字车间 */
  source: string;
  /** 回执日期 YYYY-MM-DD */
  receiptDate: string;
  note: string;
  lines: ReceiptLine[];
  status: ReceiptStatus;
  createdAt: string;
  updatedAt: string;
}

/** 一条对账结果（对应回执一行） */
export interface ReconciliationRecord {
  id: string;
  receiptId: string;
  receiptCode: string;
  lineId: string;
  /** 配对到的字模 id（未配对为空） */
  matchedMatrixId: string;
  /** 配对方式 */
  matchBy: MatchBy;
  category: ReconcileCategory;
  /** 待裁定 / 差异说明 */
  reason: string;
  /** 馆员裁定 */
  verdict: VerdictStatus;
  /** 裁定后采取的动作 */
  action: ReconcileAction;
  /** 裁定决策（确认后据此写入档案） */
  decision: ReconciliationDecision;
  resolvedAt: string;
  resolvedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 裁定决策：确认后一起更新字模、落位与缺损记录（试印记录不动） */
export interface ReconciliationDecision {
  /** 更新字模档案（编号 / 字符 / 字体等） */
  matrixPatch?: Partial<TypeMatrix>;
  /** 落位调整：直接写入的 slots（用于已存在字模的格位更正） */
  placementPatch?: { caseId: string; slots: CaseSlot[] };
  /** 落位请求：新建字模后落到指定格位（用于 create-matrix） */
  placementRequest?: { caseId: string; row: number; col: number };
  /** 新增缺损记录（字模已停用时补登） */
  defectInput?: DefectInput;
  /** 新建字模建议（档案中找不到该字模时） */
  newMatrixInput?: { code: string; character: string; font: MatrixFont };
}

/** 回执导入表单：一行文本解析后的原始结构 */
export interface ReceiptLineInput {
  code: string;
  character: string;
  font: string;
  caseCode: string;
  row: number;
  col: number;
}
