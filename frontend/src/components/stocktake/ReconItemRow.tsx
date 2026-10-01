import { useState } from 'react';
import DefectBadge from '../common/DefectBadge';
import { useReconStore, type RegisterPayload } from '../../stores/reconStore';
import type { ReconBatch, ReconItem } from '../../types/reconcile';
import {
  RECON_DECISION_LABELS,
  RECON_ITEM_LABELS,
  REGISTER_MATERIAL_OPTIONS,
  REGISTER_SIZE_OPTIONS,
} from '../../types/reconcile';
import { useUiStore } from '../../stores/uiStore';
import { positionLabel } from '../../utils/reconcile';

const TONE_CLASS: Record<string, string> = {
  ok: 'border-jade/40 bg-jade-pale text-jade',
  info: 'border-brass/40 bg-brass-pale text-brass',
  warn: 'border-seal/40 bg-seal-pale text-seal',
  danger: 'border-seal/60 bg-seal text-paper',
};

const STATUS_TEXT: Record<ReconItem['status'], string> = {
  proposed: '建议待采纳',
  pending: '待裁定',
  accepted: '已采纳',
  ignored: '已忽略',
  applied: '已落账',
};

export interface ReconItemRowProps {
  batch: ReconBatch;
  item: ReconItem;
}

/** 一条核对结果：档案对照、处理决定；未裁定前只改批次，不动档案 */
export default function ReconItemRow({ batch, item }: ReconItemRowProps) {
  const resolveItem = useReconStore((s) => s.resolveItem);
  const pushToast = useUiStore((s) => s.pushToast);
  const [sizeName, setSizeName] = useState(REGISTER_SIZE_OPTIONS[9]); // 五号
  const [material, setMaterial] = useState<(typeof REGISTER_MATERIAL_OPTIONS)[number]>('铅合金');
  const [busy, setBusy] = useState(false);

  const meta = RECON_ITEM_LABELS[item.kind];
  const locked = batch.status === 'applied';
  const resolved = item.status === 'accepted' || item.status === 'ignored' || item.status === 'applied';
  const r = item.receipt;

  const decide = async (decision: string) => {
    let payload: RegisterPayload | undefined;
    if (decision === 'register-new') payload = { sizeName, material };
    setBusy(true);
    try {
      await resolveItem(batch.id, item.id, decision, payload);
      pushToast(`第 ${r.lineNo} 行已${decision === 'ignore' || decision.includes('keep') || decision === 'reject-receipt' ? '忽略' : '采纳处理'}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '裁定失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className="rounded border border-paper-line bg-white/70 px-3 py-2.5"
      data-testid={`recon-item-${item.id}`}
      data-kind={item.kind}
      data-status={item.status}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span className={`mt-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[meta.tone]}`}>
          {meta.label}
        </span>
        <div className="min-w-[220px] flex-1">
          <p className="text-sm text-ink" data-testid="recon-item-message">
            {item.message}
          </p>
          <p className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-ink-mute">
            <span className="rounded bg-paper-deep/70 px-1.5 py-0.5">
              回执第 {r.lineNo} 行：{r.code} · {r.character} · {r.font} · {r.caseCode} ·{' '}
              {r.rc ? positionLabel(r.rc.row, r.rc.col) : r.positionText || '格位缺失'}
            </span>
            {item.snapshot.matrixCode ? (
              <span className="rounded bg-paper-deep/70 px-1.5 py-0.5">
                档案：{item.snapshot.matrixCode} · {item.snapshot.matrixCharacter} · {item.snapshot.matrixFont}
              </span>
            ) : null}
            {item.snapshot.matrixAvailability && item.snapshot.matrixAvailability !== '可用' ? (
              <DefectBadge
                type="停用"
                severity={item.snapshot.matrixAvailability === '停用' ? '中' : '轻'}
                availability={item.snapshot.matrixAvailability}
                compact
              />
            ) : null}
            {item.snapshot.holdingsText.length > 0 ? (
              <span className="rounded bg-paper-deep/70 px-1.5 py-0.5" data-testid="recon-holdings">
                档案落位：{item.snapshot.holdingsText.join('、')}
              </span>
            ) : null}
          </p>
        </div>
        <span
          className="rounded-full border border-paper-line px-2 py-0.5 text-[11px] text-ink-mute"
          data-testid="recon-item-status"
        >
          {STATUS_TEXT[item.status]}
          {resolved && item.decision ? ` · ${RECON_DECISION_LABELS[item.decision] ?? item.decision}` : ''}
        </span>
      </div>

      {item.kind === 'unknown-matrix' && !resolved ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-dashed border-paper-line bg-paper/50 px-2 py-2">
          <div>
            <label className="mt-label" htmlFor={`reg-size-${item.id}`}>
              补登记字号
            </label>
            <select
              id={`reg-size-${item.id}`}
              className="mt-input min-w-[96px]"
              value={sizeName}
              onChange={(e) => setSizeName(e.target.value)}
            >
              {REGISTER_SIZE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mt-label" htmlFor={`reg-material-${item.id}`}>
              材质
            </label>
            <select
              id={`reg-material-${item.id}`}
              className="mt-input min-w-[96px]"
              value={material}
              onChange={(e) => setMaterial(e.target.value as typeof material)}
            >
              {REGISTER_MATERIAL_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-ink-mute">
            将按回执编号 / 字符 / 字体新建字模并落位到申报格，尺寸与刻工登记后补录。
          </p>
        </div>
      ) : null}

      {!resolved && !locked ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="recon-decisions">
          {item.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="mt-btn text-[12px]"
              disabled={busy}
              data-testid={`recon-decision-${opt}`}
              onClick={() => void decide(opt)}
            >
              {RECON_DECISION_LABELS[opt] ?? opt}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
