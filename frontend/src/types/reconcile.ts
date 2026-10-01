import type { CaseSlot, TypeCase } from './case';
import type { DefectSeverity, DefectType } from './defect';
import type { MatrixAvailability, MatrixFont, TypeMatrix } from './matrix';

/** 车间回执盘点对账（Stocktake Reconciliation）：回执导入、待裁定与统一落账 */

/** 回执批次状态 */
export const RECON_BATCH_STATUSES = [
  'analyzing', // 正在核对（可从断点继续）
  'failed', // 导入 / 核对失败，回执与进度均保留
  'pending', // 核对完成，存在待馆员裁定的条目
  'ready', // 全部条目均已裁定，可执行落账
  'applied', // 已落账
] as const;
export type ReconBatchStatus = (typeof RECON_BATCH_STATUSES)[number];

/**
 * 条目类型：
 * - matched 编号一致且字符 / 字体 / 格位全部相符
 * - slot-moved 编号一致、字符字体相符，仅盘内格位不符（建议改格位）
 * - renumbered 编号在档案中找不到，但格位上有同字符同字体字模（疑似改号）
 * - char-font-mismatch 编号一致但字符或字体对不上
 * - disabled-found 盘里见到一枚已停用 / 待补刻的字模
 * - double-slot 同一枚字模在档案中占了两个格位
 * - unknown-matrix 盘里有档案找不到对应字模的格位
 * - unknown-case 回执上的字盘编号在档案中不存在
 * - bad-row 回执行无法解析（字段缺失、格位越界等）
 */
export const RECON_ITEM_KINDS = [
  'matched',
  'slot-moved',
  'renumbered',
  'char-font-mismatch',
  'disabled-found',
  'double-slot',
  'unknown-matrix',
  'unknown-case',
  'bad-row',
] as const;
export type ReconItemKind = (typeof RECON_ITEM_KINDS)[number];

/** 条目状态：建议（待馆员决定）/ 待裁定 / 已采纳 / 已忽略 / 已落账 */
export const RECON_ITEM_STATUSES = ['proposed', 'pending', 'accepted', 'ignored', 'applied'] as const;
export type ReconItemStatus = (typeof RECON_ITEM_STATUSES)[number];

/** 一条解析后的车间回执记录 */
export interface ReceiptRow {
  /** 回执内行号（1 基，不含表头） */
  lineNo: number;
  code: string;
  character: string;
  font: string;
  caseCode: string;
  /** 格位原文，例：A1 / 1-1 / 1行1列 */
  positionText: string;
  /** 解析后的 0 基行列，解析失败为 null */
  rc: { row: number; col: number } | null;
  /** 整行原文（排查用） */
  raw: string;
}

/** 回执核对时捕获的档案快照（落账前一律以此为准，未裁定不写档案） */
export interface ReconSnapshot {
  matrix?: TypeMatrix;
  typeCase?: TypeCase;
  /** 该字模在全库中的落位 */
  holdings: Array<{ typeCase: TypeCase; slots: CaseSlot[] }>;
  /** 目标格位上当前的落位 */
  declaredSlot?: CaseSlot;
}

/** 落账动作（落账时逐项执行，全部在同一个 Dexie 事务内） */
export interface ReconAction {
  /** 该条目最终采用的处理决定（见各 kind 的 options） */
  decision: string;
  /** 新登记字模（unknown-matrix register-new） */
  register?: {
    code: string;
    character: string;
    font: MatrixFont;
    sizeName: string;
    material: TypeMatrix['material'];
  };
  /** 字模字段改动：改号（code）、纠正字符 / 字体（character/font） */
  matrixPatch?: { matrixId: string } & Partial<Pick<TypeMatrix, 'code' | 'character' | 'font'>>;
  /** 字模可用性改动（停用字模复置 / 停用并取出） */
  availability?: { matrixId: string; value: MatrixAvailability };
  /** 新增的缺损记录（复置或停用都留痕） */
  addDefect?: {
    matrixId: string;
    defectType: DefectType;
    severity: DefectSeverity;
    handling: string;
    availability: MatrixAvailability;
  };
  /** 把字模落位到某字盘某格（覆盖该格现有内容） */
  place?: { caseId: string; row: number; col: number; matrixId: string; character: string };
  /** 取出某字盘中的指定格位 */
  take?: Array<{ caseId: string; row: number; col: number }>;
  /** 从某字盘取走该字模的全部落位（双占取净） */
  takeMatrix?: { caseId: string; matrixId: string };
}

/** 一条核对结果 */
export interface ReconItem {
  id: string;
  kind: ReconItemKind;
  status: ReconItemStatus;
  receipt: ReceiptRow;
  /** 档案快照（编号 / 字盘均找不到时可能为空） */
  snapshot: {
    matrixId?: string;
    caseId?: string;
    matrixCode?: string;
    matrixCharacter?: string;
    matrixFont?: string;
    matrixAvailability?: MatrixAvailability;
    /** 该字模在全库的落位描述，例：ZP-A-01 B2 / ZP-A-01 C3 */
    holdingsText: string[];
  };
  /** 说明 */
  message: string;
  /** 该类型允许的处理决定（馆员裁定用） */
  options: string[];
  decision: string;
  /** 已存在的建议动作（slot-moved / renumbered 自动给出，待馆员采纳） */
  proposedAction?: ReconAction;
  /** 馆员裁定后确定的动作（落账时执行） */
  action?: ReconAction;
  /** 同一格位回执重复行分组键，用于提示 */
  receiptDupKey?: string;
  resolvedAt?: string;
}

/** 一次车间回执导入（一个批次） */
export interface ReconBatch {
  id: string;
  /** 批次名（默认：回执-首个字盘编号-日期时间） */
  name: string;
  fileName: string;
  /** 回执原文（失败后保留，恢复时无需重新选择文件） */
  rawText: string;
  /** 回执内容哈希：同一份回执再次提交直接复用既有批次，不重复生成结果 */
  contentHash: string;
  status: ReconBatchStatus;
  items: ReconItem[];
  /** 核对进度：已处理的回执行数（断点继续） */
  processedRows: number;
  totalRows: number;
  /** 失败原因（status=failed 时） */
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

/** 核对汇总 */
export interface ReconSummary {
  total: number;
  byKind: Record<ReconItemKind, number>;
  pending: number;
  proposed: number;
  resolved: number;
  /** 是否还有未处理（proposed/pending）条目 */
  hasOpen: boolean;
}

/** 汇总一批核对条目 */
export function summarizeItems(items: ReconItem[]): ReconSummary {
  const byKind = Object.fromEntries(RECON_ITEM_KINDS.map((k) => [k, 0])) as Record<ReconItemKind, number>;
  let pending = 0;
  let proposed = 0;
  for (const item of items) {
    byKind[item.kind] += 1;
    if (item.status === 'pending') pending += 1;
    if (item.status === 'proposed') proposed += 1;
  }
  return {
    total: items.length,
    byKind,
    pending,
    proposed,
    resolved: items.filter((i) => i.status === 'accepted' || i.status === 'ignored').length,
    hasOpen: pending > 0 || proposed > 0,
  };
}

/** 条目类型的中文标签与说明 */
export const RECON_ITEM_LABELS: Record<ReconItemKind, { label: string; tone: 'ok' | 'info' | 'warn' | 'danger' }> = {
  matched: { label: '相符', tone: 'ok' },
  'slot-moved': { label: '格位不符', tone: 'info' },
  renumbered: { label: '疑似改号', tone: 'info' },
  'char-font-mismatch': { label: '字符/字体不符', tone: 'warn' },
  'disabled-found': { label: '停用字模在盘', tone: 'warn' },
  'double-slot': { label: '一枚双格', tone: 'warn' },
  'unknown-matrix': { label: '档案查无此模', tone: 'danger' },
  'unknown-case': { label: '字盘不存在', tone: 'danger' },
  'bad-row': { label: '回执行异常', tone: 'danger' },
};

/** 处理决定的中文标签 */
export const RECON_DECISION_LABELS: Record<string, string> = {
  accept: '采纳建议',
  ignore: '忽略（不改档案）',
  'accept-move': '按回执格位移位',
  'keep-placement': '保留原格位',
  'accept-renumber': '按回执改号',
  'keep-code': '保留原编号',
  'accept-correction': '按回执纠正字模字符/字体',
  'reject-receipt': '以档案为准，忽略回执',
  'reactivate-keep': '复置为可用并保留格位',
  'deactivate-remove': '维持停用并取出格位',
  'keep-declared': '保留回执申报格位、取出其余落位',
  'remove-all': '取净全部落位',
  'register-new': '补登记新字模',
};

/** 可选字号 / 材质（补登记新字模用） */
export const REGISTER_SIZE_OPTIONS = ['初号', '小初', '一号', '小一', '二号', '小二', '三号', '小三', '四号', '小四', '五号', '小五', '六号', '小六', '七号', '八号'];
export const REGISTER_MATERIAL_OPTIONS = ['铜模', '木活字', '铅合金'] as const;
