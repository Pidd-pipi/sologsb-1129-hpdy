/**
 * 盘点对账引擎验证脚本：用示例档案 + 演示回执跑一遍，核对分类结果。
 * 运行：npx tsx scripts/test-reconcile.ts
 */
import type { TypeMatrix } from '../src/types/matrix';
import type { TypeCase } from '../src/types/case';
import type { Receipt } from '../src/types/receipt';
import { reconcileReceipt, type ReconcileContext } from '../src/utils/reconcile';
import { ptOfSize } from '../src/types/matrix';

const now = new Date().toISOString();

function m(
  id: string,
  code: string,
  character: string,
  font: TypeMatrix['font'],
  availability: TypeMatrix['availability'] = '可用',
): TypeMatrix {
  return {
    id,
    code,
    character,
    font,
    sizeName: '五号',
    sizePt: ptOfSize('五号'),
    material: '铅合金',
    faceWidthMm: 3.7,
    bodyHeightMm: 5.6,
    madeYear: 1985,
    engraver: '测试',
    availability,
    note: '',
    createdAt: now,
    updatedAt: now,
  };
}

const matrices: TypeMatrix[] = [
  m('m-1001', 'ZM-1985-001', '活', '宋体'),
  m('m-1002', 'ZM-1978-002', '字', '宋体'),
  m('m-1003', 'ZM-1978-003', '印', '宋体'),
  m('m-1004', 'ZM-1990-004', '刷', '宋体'),
  m('m-1005', 'ZM-1962-005', '排', '楷体', '待补刻'),
  m('m-1006', 'ZM-1962-006', '版', '楷体'),
  m('m-1007', 'ZM-1975-007', '铅', '仿宋'),
  m('m-1008', 'ZM-1993-008', '模', '宋体', '停用'),
  m('m-1009', 'ZM-1971-009', '铜', '仿宋'),
  m('m-1010', 'ZM-1965-010', '刻', '楷体'),
  m('m-1011', 'ZM-1988-011', '墨', '宋体', '停用'),
  m('m-1012', 'ZM-1958-012', '纸', '仿宋'),
  m('m-1013', 'ZM-1980-013', '宋', '宋体'),
  m('m-1014', 'ZM-1995-014', '体', '楷体', '待补刻'),
  m('m-1015', 'ZM-1968-015', '匠', '仿宋'),
  m('m-1016', 'ZM-1991-016', '序', '宋体'),
];

const slot = (row: number, col: number, matrixId: string, character: string) => ({
  row,
  col,
  character,
  matrixId,
  placedAt: now,
});

const caseA: TypeCase = {
  id: 'case-1001',
  code: 'ZP-A-01',
  kind: '常用字盘',
  rows: 6,
  cols: 8,
  slots: [
    slot(0, 0, 'm-1001', '活'),
    slot(0, 1, 'm-1002', '字'),
    slot(0, 2, 'm-1003', '印'),
    slot(0, 3, 'm-1004', '刷'),
    slot(1, 0, 'm-1005', '排'),
    slot(1, 1, 'm-1006', '版'),
    slot(1, 2, 'm-1007', '铅'),
    slot(1, 3, 'm-1009', '铜'),
    slot(2, 0, 'm-1010', '刻'),
    slot(2, 1, 'm-1012', '纸'),
    slot(2, 2, 'm-1013', '宋'),
    slot(2, 3, 'm-1014', '体'),
  ],
  matrixId: [],
  workStation: '一号',
  createdAt: now,
  updatedAt: now,
};

const ctx: ReconcileContext = { matrices, cases: [caseA], defects: [] };

const receipt: Receipt = {
  id: 'rcp-test',
  code: 'HZ-TEST-01',
  source: '测试车间',
  receiptDate: '2025-06-01',
  note: '',
  status: '待核对',
  createdAt: now,
  updatedAt: now,
  lines: [
    { id: 'ln1', code: 'ZM-1958-012', character: '纸', font: '仿宋', caseCode: 'ZP-A-01', row: 2, col: 1 }, // 一致
    { id: 'ln2', code: 'ZM-1985-001', character: '活', font: '宋体', caseCode: 'ZP-A-01', row: 0, col: 0 }, // 一致
    { id: 'ln3', code: 'ZM-1985-001', character: '活', font: '宋体', caseCode: 'ZP-A-01', row: 1, col: 1 }, // 占两位
    { id: 'ln4', code: 'ZM-1993-008', character: '模', font: '宋体', caseCode: 'ZP-A-01', row: 1, col: 3 }, // 停用+格位不符
    { id: 'ln5', code: 'ZM-1978-099', character: '字', font: '宋体', caseCode: 'ZP-A-01', row: 0, col: 1 }, // 改号
    { id: 'ln6', code: 'ZM-XXXX-000', character: '龙', font: '宋体', caseCode: 'ZP-A-01', row: 3, col: 0 }, // 找不到
    { id: 'ln7', code: 'ZM-1962-005', character: '排', font: '楷体', caseCode: 'ZP-A-01', row: 1, col: 0 }, // 待补刻
  ],
};

const results = reconcileReceipt(receipt, ctx);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const byId = new Map(results.map((r) => [r.line.id, r]));

console.log('== 对账结果 ==');
for (const r of results) {
  console.log(
    `  ${r.line.id} ${r.line.code} ${r.line.character} => ${r.category} / ${r.matchBy} / ${r.action} :: ${r.reason}`,
  );
}

console.log('\n== 断言 ==');
check('ln1 一致', byId.get('ln1')!.category === '一致');
check('ln2 待裁定(占两位)', byId.get('ln2')!.category === '待裁定' && byId.get('ln2')!.reason.includes('占两个格位'));
check('ln3 待裁定(占两位)', byId.get('ln3')!.category === '待裁定' && byId.get('ln3')!.reason.includes('占两个格位'));
check('ln4 待裁定(停用)', byId.get('ln4')!.category === '待裁定' && byId.get('ln4')!.reason.includes('停用'));
check('ln4 动作 add-defect', byId.get('ln4')!.action === 'add-defect');
check('ln5 待裁定(改号)', byId.get('ln5')!.category === '待裁定' && byId.get('ln5')!.matchBy === 'char-font-position');
check('ln5 动作 update-matrix', byId.get('ln5')!.action === 'update-matrix');
check('ln5 配对到 m-1002', byId.get('ln5')!.matchedMatrix?.id === 'm-1002');
check('ln6 待裁定(找不到)', byId.get('ln6')!.category === '待裁定' && byId.get('ln6')!.action === 'create-matrix');
check('ln7 待裁定(待补刻)', byId.get('ln7')!.category === '待裁定' && byId.get('ln7')!.reason.includes('待补刻'));
check('ln7 动作 add-defect', byId.get('ln7')!.action === 'add-defect');

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
