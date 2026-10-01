import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useReconStore } from '../../stores/reconStore';
import { useUiStore } from '../../stores/uiStore';

/** 车间回执导入：选择 .txt/.csv 文件或直接粘贴，每行 编号/字符/字体/字盘/格位 */
export default function ReceiptImportPanel() {
  const importReceipt = useReconStore((s) => s.importReceipt);
  const pushToast = useUiStore((s) => s.pushToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === 'string' ? reader.result : '');
      setFileName(file.name);
    };
    reader.onerror = () => pushToast('回执文件读取失败', 'error');
    reader.readAsText(file, 'utf-8');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      pushToast('请先选择回执文件或粘贴回执内容', 'warn');
      return;
    }
    setBusy(true);
    try {
      const { duplicated } = await importReceipt(text, fileName);
      if (duplicated) {
        pushToast('同一份回执已提交过，已打开既有核对结果，不重复生成', 'warn');
      } else {
        pushToast('回执已导入，正在核对…');
      }
      setText('');
      setFileName('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '回执导入失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mt-panel space-y-3 px-4 py-3" onSubmit={handleSubmit} data-testid="receipt-import-form">
      <h3 className="font-song text-sm font-semibold text-ink">导入车间回执</h3>
      <div>
        <label className="mt-label" htmlFor="receipt-file">
          回执文件（.txt / .csv，UTF-8）
        </label>
        <input
          id="receipt-file"
          ref={fileRef}
          data-testid="receipt-file"
          type="file"
          accept=".txt,.csv,text/plain,text/csv"
          className="mt-input file:mr-2 file:rounded file:border-0 file:bg-paper-deep file:px-2 file:py-1 file:text-xs file:text-ink-soft"
          onChange={handleFile}
        />
      </div>
      <div>
        <label className="mt-label" htmlFor="receipt-text">
          或粘贴回执内容
        </label>
        <textarea
          id="receipt-text"
          data-testid="receipt-text"
          className="mt-input h-32 resize-y font-mono text-xs leading-5"
          placeholder={'字模编号\t字符\t字体\t字盘编号\t盘内格位\nZM-1985-001\t活\t宋体\tZP-A-01\tA1'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!fileName) setFileName('粘贴回执');
          }}
        />
        <p className="mt-hint">
          首行可为表头（字模编号 / 字符 / 字体 / 字盘编号 / 盘内格位）；格位支持 A1、1-1、1行1列。
        </p>
      </div>
      <button type="submit" className="mt-btn mt-btn-primary" disabled={busy} data-testid="receipt-import-btn">
        {busy ? '导入核对中…' : '提交并核对'}
      </button>
    </form>
  );
}
