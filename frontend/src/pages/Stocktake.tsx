import { useEffect } from 'react';
import EmptyState from '../components/common/EmptyState';
import ReceiptImportPanel from '../components/stocktake/ReceiptImportPanel';
import ReconBatchDetail from '../components/stocktake/ReconBatchDetail';
import { useReconStore } from '../stores/reconStore';
import type { ReconBatchStatus } from '../types/reconcile';
import { summarizeItems } from '../types/reconcile';
import { formatStamp } from '../utils/format';

const STATUS_TEXT: Record<ReconBatchStatus, string> = {
  analyzing: '核对中',
  failed: '失败（可恢复）',
  pending: '待裁定',
  ready: '可落账',
  applied: '已落账',
};

const STATUS_DOT: Record<ReconBatchStatus, string> = {
  analyzing: 'bg-brass',
  failed: 'bg-seal',
  pending: 'bg-seal',
  ready: 'bg-jade',
  applied: 'bg-jade/60',
};

/** 车间回执盘点对账：导入 → 编号配对 → 改号按字符 / 字体 / 格位确认 → 待裁定 → 统一落账 */
export default function Stocktake() {
  const batches = useReconStore((s) => s.batches);
  const loaded = useReconStore((s) => s.loaded);
  const load = useReconStore((s) => s.load);
  const clearApplied = useReconStore((s) => s.clearApplied);

  useEffect(() => {
    void load();
  }, [load]);

  const activeBatch = batches.find((b) => b.status !== 'applied') ?? batches[0];
  const appliedCount = batches.filter((b) => b.status === 'applied').length;

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="stocktake-title">
            车间回执盘点对账
          </h2>
          <p className="mt-sub">
            先按字模编号配对；编号已改的按字符、字体与盘内格位确认。一枚双格、档案查无此模、停用字模在盘等先列待裁定，确认前不改档案。
          </p>
        </div>
        <span className="mt-chip" data-testid="recon-batch-count">
          批次 {batches.length}
        </span>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
        <aside className="space-y-3">
          <ReceiptImportPanel />

          <div className="mt-panel">
            <div className="mt-panel-head">
              <h3 className="font-song text-sm font-semibold text-ink">核对批次</h3>
            </div>
            <ul className="divide-y divide-paper-line" data-testid="recon-batch-list">
              {batches.length === 0 ? (
                <li className="px-4 py-3 text-xs text-ink-mute">
                  {loaded ? '还没有批次，导入第一份车间回执开始盘点。' : '正在读取盘点批次…'}
                </li>
              ) : (
                batches.map((b) => {
                  const summary = summarizeItems(b.items);
                  return (
                    <li
                      key={b.id}
                      className={`px-4 py-2 ${activeBatch?.id === b.id ? 'bg-seal-pale/60' : ''}`}
                      data-testid={`recon-batch-item-${b.id}`}
                    >
                      <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[b.status]}`} aria-hidden="true" />
                        {b.name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-mute">
                        {STATUS_TEXT[b.status]} · {b.totalRows} 行
                        {summary.pending + summary.proposed > 0
                          ? ` · 待处理 ${summary.pending + summary.proposed}`
                          : ''}
                        {' · '}
                        {formatStamp(b.updatedAt)}
                      </p>
                    </li>
                  );
                })
              )}
            </ul>
            {appliedCount > 0 ? (
              <div className="border-t border-paper-line px-4 py-2">
                <button
                  type="button"
                  className="mt-btn w-full justify-center text-[12px]"
                  data-testid="recon-clear-applied"
                  onClick={() => void clearApplied()}
                >
                  清除 {appliedCount} 个已落账批次（仅清对账记录）
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-panel px-4 py-3 text-[11px] leading-relaxed text-ink-mute" data-testid="recon-rules">
            <h4 className="mb-1 font-song text-xs font-semibold text-ink-soft">对账规则</h4>
            <ol className="list-decimal space-y-1 pl-4">
              <li>编号能配对：核对字符、字体与盘内格位；仅格位不符给出移位建议。</li>
              <li>编号配不上：申报格位上有同字符同字体字模的，列为「疑似改号」。</li>
              <li>一枚占两格、档案查无此模、停用字模在盘：先列待裁定。</li>
              <li>馆员全部处理后一次性落账，同步更新字模、落位与缺损记录。</li>
              <li>既有试印记录照原样保留；导入失败保留回执与进度，可断点续核。</li>
            </ol>
          </div>
        </aside>

        {activeBatch ? (
          <ReconBatchDetail key={activeBatch.id} batch={activeBatch} />
        ) : (
          <EmptyState
            title="尚未导入车间回执"
            description="选择车间提交的回执文件（或粘贴文本）提交并核对。同一回执再次提交不会重复生成结果。"
            testId="recon-empty"
          />
        )}
      </div>
    </div>
  );
}
