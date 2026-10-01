import { useMemo, useState } from 'react';
import ReconItemRow from './ReconItemRow';
import { RECON_KIND_ORDER, useReconStore } from '../../stores/reconStore';
import type { ReconBatch, ReconItemStatus } from '../../types/reconcile';
import { RECON_ITEM_LABELS, summarizeItems } from '../../types/reconcile';
import { useUiStore } from '../../stores/uiStore';
import { formatStamp, percent } from '../../utils/format';

const STATUS_META: Record<ReconBatch['status'], { text: string; cls: string }> = {
  analyzing: { text: '核对中', cls: 'border-brass/50 bg-brass-pale text-brass' },
  failed: { text: '导入失败', cls: 'border-seal/60 bg-seal text-paper' },
  pending: { text: '待馆员裁定', cls: 'border-seal/40 bg-seal-pale text-seal' },
  ready: { text: '可落账', cls: 'border-jade/50 bg-jade-pale text-jade' },
  applied: { text: '已落账', cls: 'border-jade/50 bg-jade text-paper' },
};

type FilterMode = 'open' | 'issues' | 'all';

export default function ReconBatchDetail({ batch }: { batch: ReconBatch }) {
  const continueBatch = useReconStore((s) => s.continueBatch);
  const applyBatch = useReconStore((s) => s.applyBatch);
  const removeBatch = useReconStore((s) => s.removeBatch);
  const pushToast = useUiStore((s) => s.pushToast);
  const [filter, setFilter] = useState<FilterMode>('open');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const summary = useMemo(() => summarizeItems(batch.items), [batch.items]);
  const progress = percent(batch.processedRows, Math.max(batch.totalRows, 1));
  const statusMeta = STATUS_META[batch.status];

  const visibleItems = useMemo(() => {
    const rank = (kind: (typeof RECON_KIND_ORDER)[number]) => RECON_KIND_ORDER.indexOf(kind);
    const filtered = batch.items.filter((i) => {
      if (filter === 'all') return true;
      if (filter === 'issues') return i.kind !== 'matched';
      return i.status === 'proposed' || i.status === 'pending';
    });
    return [...filtered].sort((a, b) => {
      const openRank = (s: ReconItemStatus) => (s === 'pending' ? 0 : s === 'proposed' ? 1 : 2);
      if (openRank(a.status) !== openRank(b.status)) return openRank(a.status) - openRank(b.status);
      if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind);
      return a.receipt.lineNo - b.receipt.lineNo;
    });
  }, [batch.items, filter]);

  const handleContinue = async () => {
    setBusy(true);
    try {
      await continueBatch(batch.id);
      pushToast('已从断点继续核对');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '继续核对失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    setBusy(true);
    try {
      const s = await applyBatch(batch.id);
      pushToast(
        `已落账：更新字模 ${s.matricesUpdated} 枚、新登记 ${s.matricesCreated} 枚、更新字盘 ${s.casesUpdated} 个、缺损记录 ${s.defectsAdded} 条；试印记录原样保留`,
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '落账失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    await removeBatch(batch.id);
    pushToast('批次及核对结果已删除', 'warn');
  };

  return (
    <section className="mt-panel" data-testid={`recon-batch-${batch.id}`}>
      <div className="mt-panel-head">
        <div>
          <h3 className="font-song text-sm font-semibold text-ink">
            {batch.name}
            <span className={`ml-2 rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusMeta.cls}`} data-testid="recon-batch-status">
              {statusMeta.text}
            </span>
          </h3>
          <p className="mt-sub">
            来源 {batch.fileName} · 回执 {batch.totalRows} 行 · 提交 {formatStamp(batch.createdAt)}
            {batch.appliedAt ? ` · 落账 ${formatStamp(batch.appliedAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {batch.status === 'ready' ? (
            <button type="button" className="mt-btn mt-btn-primary" data-testid="recon-apply-btn" disabled={busy} onClick={handleApply}>
              确认无误，统一落账
            </button>
          ) : null}
          {(batch.status === 'failed' || batch.status === 'analyzing') && batch.processedRows < batch.totalRows ? (
            <button type="button" className="mt-btn mt-btn-primary" data-testid="recon-continue-btn" disabled={busy} onClick={handleContinue}>
              {batch.status === 'failed' ? '恢复并接着核对' : '继续核对'}
            </button>
          ) : null}
          {batch.status !== 'applied' ? (
            <button
              type="button"
              className={`mt-btn ${confirmDelete ? 'border-seal text-seal' : ''}`}
              data-testid="recon-delete-btn"
              onClick={handleDelete}
            >
              {confirmDelete ? '再点一次确认删除' : '删除批次'}
            </button>
          ) : null}
        </div>
      </div>

      {batch.status === 'analyzing' || (batch.status === 'failed' && batch.processedRows > 0) ? (
        <div className="border-b border-paper-line px-4 py-2" data-testid="recon-progress">
          <div className="h-1.5 overflow-hidden rounded bg-paper-deep">
            <div className="h-full bg-brass transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-ink-mute">
            已核对 {batch.processedRows} / {batch.totalRows} 行（{progress}%），进度已保存，中断后可继续
          </p>
        </div>
      ) : null}

      {batch.status === 'failed' ? (
        <div className="border-b border-seal/30 bg-seal-pale px-4 py-2 text-xs text-seal" data-testid="recon-error">
          导入 / 核对失败：{batch.errorMessage || '未知原因'}。回执原文与已核对进度均保留，恢复后接着核对。
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 border-b border-paper-line px-4 py-2">
        {(['open', 'issues', 'all'] as FilterMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            data-testid={`recon-filter-${mode}`}
            onClick={() => setFilter(mode)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
              filter === mode ? 'border-seal bg-seal text-paper' : 'border-paper-line bg-white text-ink-soft hover:border-seal'
            }`}
          >
            {mode === 'open' ? `待处理 ${summary.pending + summary.proposed}` : mode === 'issues' ? '全部问题' : `全部 ${summary.total}`}
          </button>
        ))}
        <span className="ml-auto flex flex-wrap gap-1" data-testid="recon-kind-summary">
          {RECON_KIND_ORDER.map((kind) =>
            summary.byKind[kind] > 0 ? (
              <span key={kind} className="rounded bg-paper-deep/70 px-1.5 py-0.5 text-[11px] text-ink-soft">
                {RECON_ITEM_LABELS[kind].label} {summary.byKind[kind]}
              </span>
            ) : null,
          )}
        </span>
      </div>

      {batch.status === 'pending' ? (
        <div className="border-b border-seal/30 bg-seal-pale/60 px-4 py-2 text-[11px] text-seal" data-testid="recon-pending-hint">
          尚有 {summary.pending + summary.proposed} 条待馆员裁定；确认前只记录决定，不会改动字模、落位与缺损档案。
        </div>
      ) : null}
      {batch.status === 'ready' ? (
        <div className="border-b border-jade/30 bg-jade-pale/60 px-4 py-2 text-[11px] text-jade" data-testid="recon-ready-hint">
          全部条目已处理。落账将在同一事务内更新字模、字盘格位与缺损记录；既有试印记录照原样保留。
        </div>
      ) : null}

      <ul className="space-y-2 px-4 py-3" data-testid="recon-item-list">
        {visibleItems.length === 0 ? (
          <li className="px-2 py-6 text-center text-xs text-ink-mute" data-testid="recon-no-item">
            {batch.items.length === 0 ? '尚无核对结果。' : '当前筛选下没有条目。'}
          </li>
        ) : (
          visibleItems.map((item) => <ReconItemRow key={item.id} batch={batch} item={item} />)
        )}
      </ul>

      <details className="border-t border-paper-line px-4 py-2 text-[11px] text-ink-mute" data-testid="recon-raw">
        <summary className="cursor-pointer select-none">查看回执原文（{batch.totalRows} 行）</summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-paper/60 p-2 font-mono text-[11px] leading-5">
          {batch.rawText}
        </pre>
      </details>
    </section>
  );
}
