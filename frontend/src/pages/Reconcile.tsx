import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import EmptyState from '../components/common/EmptyState';
import { useCaseStore } from '../stores/caseStore';
import { useMatrixStore } from '../stores/matrixStore';
import { recordsOfReceipt, useReceiptStore } from '../stores/receiptStore';
import { useUiStore } from '../stores/uiStore';
import type { ReceiptLine } from '../types/receipt';
import { lineInputToLine, parseReceiptLine, slotLabel, summarizeResults } from '../utils/reconcile';
import { formatStamp } from '../utils/format';

/** 演示回执：覆盖一致 / 占两位 / 停用 / 改号 / 找不到 / 待补刻六类情形 */
const SAMPLE_RECEIPT_TEXT = [
  'ZM-1958-012,纸,仿宋,ZP-A-01,3,2',
  'ZM-1985-001,活,宋体,ZP-A-01,1,1',
  'ZM-1985-001,活,宋体,ZP-A-01,2,2',
  'ZM-1993-008,模,宋体,ZP-A-01,2,4',
  'ZM-1978-099,字,宋体,ZP-A-01,1,2',
  'ZM-XXXX-000,龙,宋体,ZP-A-01,4,1',
  'ZM-1962-005,排,楷体,ZP-A-01,2,1',
].join('\n');

const MATCH_BY_LABEL: Record<string, string> = {
  code: '按编号配对',
  'char-font-position': '改号后按字符/字体/格位配对',
  none: '未配对',
};

const ACTION_LABEL: Record<string, string> = {
  none: '无需改动',
  'update-matrix': '更正字模档案',
  'update-placement': '调整落位',
  'add-defect': '登记缺损并停用',
  'create-matrix': '新建字模档案并落位',
};

/** `/reconcile` 盘点对账：导入车间回执，先按编号配对，改号后按字符 / 字体 / 格位确认 */
export default function Reconcile() {
  const receipts = useReceiptStore((s) => s.receipts);
  const records = useReceiptStore((s) => s.records);
  const loaded = useReceiptStore((s) => s.loaded);
  const load = useReceiptStore((s) => s.load);
  const importReceipt = useReceiptStore((s) => s.importReceipt);
  const rerunReconcile = useReceiptStore((s) => s.rerunReconcile);
  const confirmVerdict = useReceiptStore((s) => s.confirmVerdict);
  const rejectVerdict = useReceiptStore((s) => s.rejectVerdict);
  const matrices = useMatrixStore((s) => s.matrices);
  const cases = useCaseStore((s) => s.cases);
  const pushToast = useUiStore((s) => s.pushToast);

  const [code, setCode] = useState('');
  const [source, setSource] = useState('一号排字车间');
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'consistent'>('all');
  const [operator, setOperator] = useState('馆员');

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId && receipts.length > 0) setSelectedId(receipts[0].id);
  }, [receipts, selectedId]);

  const selected = receipts.find((r) => r.id === selectedId);
  const selectedRecords = useMemo(
    () => (selected ? recordsOfReceipt(records, selected.id) : []),
    [records, selected],
  );
  // 按回执行顺序展示，便于逐行核对
  const orderedRecords = useMemo(() => {
    if (!selected) return [];
    return selected.lines
      .map((line) => selectedRecords.find((r) => r.lineId === line.id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));
  }, [selected, selectedRecords]);
  const summary = useMemo(() => summarizeResults(selectedRecords), [selectedRecords]);

  const matrixById = useMemo(() => {
    const m = new Map<string, (typeof matrices)[number]>();
    matrices.forEach((x) => m.set(x.id, x));
    return m;
  }, [matrices]);

  const caseCodeOf = (caseId: string) => cases.find((c) => c.id === caseId)?.code ?? '';

  const parsedLines = useMemo(() => {
    const lines: ReceiptLine[] = [];
    const errors: string[] = [];
    text.split('\n').forEach((raw, idx) => {
      const t = raw.trim();
      if (!t) return;
      const parsed = parseReceiptLine(t);
      if (!parsed) {
        errors.push(`第 ${idx + 1} 行格式不正确：${t}`);
        return;
      }
      lines.push(lineInputToLine(parsed));
    });
    return { lines, errors };
  }, [text]);

  const handleImport = async (e: FormEvent) => {
    e.preventDefault();
    setParseErrors(parsedLines.errors);
    if (parsedLines.errors.length > 0) {
      pushToast('回执中有无法解析的行，请按「编号,字符,字体,字盘,行,列」格式修正', 'warn');
      return;
    }
    if (parsedLines.lines.length === 0) {
      pushToast('请先粘贴回执内容', 'warn');
      return;
    }
    setSubmitting(true);
    try {
      const res = await importReceipt({
        code,
        source,
        receiptDate,
        note,
        lines: parsedLines.lines,
      });
      if (res.duplicated) {
        pushToast(`回执 ${res.receipt.code} 已核对过，已为你载入上次结果，不重复生成`);
      } else {
        const s = summarizeResults(res.records);
        pushToast(`已导入回执 ${res.receipt.code}：一致 ${s.consistent}，待裁定 ${s.pending}`);
      }
      setSelectedId(res.receipt.id);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '导入失败，回执已保留，可稍后重新核对', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const visibleRecords = useMemo(() => {
    if (filter === 'pending') return orderedRecords.filter((r) => r.category === '待裁定');
    if (filter === 'consistent') return orderedRecords.filter((r) => r.category === '一致');
    return orderedRecords;
  }, [orderedRecords, filter]);

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="reconcile-title">
            盘点对账
          </h2>
          <p className="mt-sub">
            导入车间回执，先按字模编号配对，改号后按字符、字体与盘内格位确认；占两位、找不到或已停用的字模先列待裁定，确认后再更新档案。
          </p>
        </div>
        <span className="mt-chip" data-testid="receipt-count">
          回执 {receipts.length} 份
        </span>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
        {/* 左：导入 + 回执清单 */}
        <aside className="space-y-3">
          <form className="mt-panel space-y-3 px-4 py-3" onSubmit={handleImport} data-testid="receipt-import-form">
            <h3 className="font-song text-sm font-semibold text-ink">导入车间回执</h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mt-label" htmlFor="receipt-code">
                  回执编号
                </label>
                <input
                  id="receipt-code"
                  data-testid="receipt-code-input"
                  className="mt-input"
                  placeholder="例：HZ-20250601-01"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <div>
                <label className="mt-label" htmlFor="receipt-date">
                  回执日期
                </label>
                <input
                  id="receipt-date"
                  data-testid="receipt-date-input"
                  type="date"
                  className="mt-input"
                  value={receiptDate}
                  onChange={(e) => setReceiptDate(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="mt-label" htmlFor="receipt-source">
                车间来源
              </label>
              <input
                id="receipt-source"
                data-testid="receipt-source-input"
                className="mt-input"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </div>
            <div>
              <label className="mt-label" htmlFor="receipt-text">
                回执明细（每行：编号,字符,字体,字盘,行,列）
              </label>
              <textarea
                id="receipt-text"
                data-testid="receipt-text-input"
                className="mt-input h-40 font-mono text-[11px]"
                placeholder={'ZM-1985-001,活,宋体,ZP-A-01,1,1\nZM-1978-002,字,宋体,ZP-A-01,1,2'}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <p className="mt-hint">行、列为盘内格位（从 1 开始）；字体留空则只按字符与格位确认。</p>
              {parseErrors.length > 0 ? (
                <ul className="mt-1 space-y-0.5" data-testid="receipt-parse-errors">
                  {parseErrors.map((err, i) => (
                    <li key={i} className="mt-error">
                      {err}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="receipt-note">
                备注
              </label>
              <input
                id="receipt-note"
                data-testid="receipt-note-input"
                className="mt-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="mt-btn mt-btn-primary" data-testid="receipt-import-btn" disabled={submitting}>
                {submitting ? '核对中…' : '导入并核对'}
              </button>
              <button
                type="button"
                className="mt-btn"
                data-testid="receipt-sample-btn"
                onClick={() => {
                  setCode('HZ-20250601-01');
                  setText(SAMPLE_RECEIPT_TEXT);
                }}
              >
                填入演示回执
              </button>
            </div>
            <p className="mt-hint">
              导入失败也会保留回执与进度，恢复后可重新核对；同一回执编号再次提交不重复生成结果。
            </p>
          </form>

          <div className="mt-panel">
            <div className="mt-panel-head">
              <h3 className="font-song text-sm font-semibold text-ink">回执清单</h3>
            </div>
            <ul className="divide-y divide-paper-line" data-testid="receipt-list">
              {receipts.length === 0 ? (
                <li className="px-4 py-3 text-xs text-ink-mute">
                  {loaded ? '暂无回执，请在上方导入。' : '正在读取对账档案…'}
                </li>
              ) : (
                receipts.map((r) => {
                  const rs = recordsOfReceipt(records, r.id);
                  const s = summarizeResults(rs);
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        data-testid={`receipt-item-${r.id}`}
                        onClick={() => setSelectedId(r.id)}
                        className={`flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition hover:bg-paper-deep/60 ${
                          selected?.id === r.id ? 'bg-seal-pale/70' : ''
                        }`}
                      >
                        <span className="font-song text-sm text-ink">
                          {r.code}
                          <span className="ml-2 text-[11px] text-ink-mute">{r.source}</span>
                        </span>
                        <span className="text-[11px] text-ink-mute">
                          {r.receiptDate} · {r.lines.length} 行 · 一致 {s.consistent} · 待裁定 {s.pending}
                          {s.rejected > 0 ? ` · 已驳回 ${s.rejected}` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </aside>

        {/* 右：回执核对结果 */}
        {selected ? (
          <section className="space-y-3">
            <div className="mt-panel">
              <div className="mt-panel-head">
                <div>
                  <h3 className="font-song text-sm font-semibold text-ink">
                    {selected.code} · 核对结果
                  </h3>
                  <p className="mt-sub">
                    {selected.source} · {selected.receiptDate} · 共 {summary.total} 行 · 一致 {summary.consistent} · 待裁定 {summary.pending}
                    {summary.rejected > 0 ? ` · 已驳回 ${summary.rejected}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="mt-input w-auto"
                    data-testid="reconcile-filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as typeof filter)}
                  >
                    <option value="all">全部</option>
                    <option value="pending">只看待裁定</option>
                    <option value="consistent">只看一致</option>
                  </select>
                  <input
                    className="mt-input w-28"
                    data-testid="reconcile-operator"
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                    placeholder="裁定人"
                  />
                  <button
                    type="button"
                    className="mt-btn"
                    data-testid="reconcile-rerun-btn"
                    onClick={async () => {
                      try {
                        await rerunReconcile(selected.id);
                        pushToast('已重新核对，已裁定结果保留');
                      } catch (err) {
                        pushToast(err instanceof Error ? err.message : '重新核对失败', 'error');
                      }
                    }}
                  >
                    重新核对
                  </button>
                </div>
              </div>
            </div>

            {visibleRecords.length === 0 ? (
              <EmptyState
                title={filter === 'pending' ? '没有待裁定项' : '没有一致项'}
                description="当前筛选下没有对账记录。"
                testId="reconcile-empty"
              />
            ) : (
              <ul className="space-y-2" data-testid="reconcile-record-list">
                {visibleRecords.map((rec) => {
                  const line = selected.lines.find((l) => l.id === rec.lineId);
                  if (!line) return null;
                  const matrix = rec.matchedMatrixId ? matrixById.get(rec.matchedMatrixId) : undefined;
                  const isPending = rec.category === '待裁定' && rec.verdict === 'pending';
                  const isRejected = rec.verdict === 'rejected';
                  return (
                    <li
                      key={rec.id}
                      className={`mt-panel px-4 py-3 ${
                        isPending ? 'border-brass/50 bg-brass-pale/30' : ''
                      } ${isRejected ? 'opacity-70' : ''}`}
                      data-testid={`reconcile-record-${rec.id}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-song text-lg text-ink">{line.character}</span>
                            <span className="text-xs text-ink-mute">{line.code}</span>
                            {line.font ? <span className="mt-chip">{line.font}</span> : null}
                            <span className="mt-chip">
                              {line.caseCode} {slotLabel(line.row, line.col)}
                            </span>
                            <span
                              className={`mt-chip ${
                                rec.category === '一致'
                                  ? 'border-jade/40 text-jade'
                                  : 'border-brass/50 text-brass'
                              }`}
                            >
                              {rec.category}
                            </span>
                            {rec.verdict === 'confirmed' ? (
                              <span className="mt-chip border-jade/40 text-jade">已确认</span>
                            ) : null}
                            {isRejected ? (
                              <span className="mt-chip border-ink/30 text-ink-mute">已驳回</span>
                            ) : null}
                          </div>
                          <p className="text-[11px] text-ink-mute">
                            {MATCH_BY_LABEL[rec.matchBy] ?? rec.matchBy}
                            {matrix ? (
                              <>
                                {' · '}配对字模：
                                <Link
                                  className="text-seal hover:underline"
                                  to={`/matrices/${matrix.id}`}
                                  data-testid={`reconcile-matrix-link-${rec.id}`}
                                >
                                  {matrix.code}（{matrix.font}/{matrix.sizeName}）
                                </Link>
                                {' · '}当前状态：{matrix.availability}
                              </>
                            ) : null}
                          </p>
                          {rec.reason ? (
                            <p className="text-xs text-seal" data-testid={`reconcile-reason-${rec.id}`}>
                              {rec.reason}
                            </p>
                          ) : null}
                          {isPending && rec.action !== 'none' ? (
                            <p className="text-[11px] text-ink-soft">
                              建议处理：{ACTION_LABEL[rec.action] ?? rec.action}
                              {rec.decision.placementPatch
                                ? `（落位到 ${caseCodeOf(rec.decision.placementPatch.caseId)}）`
                                : ''}
                            </p>
                          ) : null}
                          {rec.verdict !== 'pending' ? (
                            <p className="text-[11px] text-ink-mute">
                              {rec.resolvedBy} · {formatStamp(rec.resolvedAt)}
                            </p>
                          ) : null}
                        </div>
                        {isPending ? (
                          <div className="flex flex-wrap gap-2">
                            {rec.action !== 'none' ? (
                              <button
                                type="button"
                                className="mt-btn mt-btn-primary"
                                data-testid={`reconcile-confirm-${rec.id}`}
                                onClick={async () => {
                                  try {
                                    await confirmVerdict(rec.id, operator);
                                    pushToast(`已确认「${line.character}」并更新档案`);
                                  } catch (err) {
                                    pushToast(err instanceof Error ? err.message : '裁定失败', 'error');
                                  }
                                }}
                              >
                                确认更正
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="mt-btn"
                              data-testid={`reconcile-reject-${rec.id}`}
                              onClick={async () => {
                                try {
                                  await rejectVerdict(rec.id);
                                  pushToast('已驳回，维持档案不变', 'warn');
                                } catch (err) {
                                  pushToast(err instanceof Error ? err.message : '驳回失败', 'error');
                                }
                              }}
                            >
                              维持档案
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : (
          <EmptyState
            title="尚未选择回执"
            description="在左侧导入车间回执，或选择一份已有回执查看核对结果。"
            testId="reconcile-empty-selected"
          />
        )}
      </div>
    </div>
  );
}
