import type { ImportBatch } from './types';

// 外聘复核员「沈确」断网期间在本机改好的清单回中心合并。
// 批带：文档版本 docVersion、区域版本 regionVersion、操作者 operator、复核号 reviewNo。
export function offlineBatch(): ImportBatch {
  return {
    batchId: 'BATCH-EXT-20260929-01',
    operator: '沈确（外聘复核员）',
    exportedAt: '离线 09-29 17:42 导出',
    importedAt: '',
    items: [
      {
        docId: 'DOC-00418',
        // 离线基线：外聘导出时中心是迁移后的首版
        docVersion: 1,
        regionVersion: 1,
        classification: '严格机密',
        classVersion: 1,
        redactions: [
          // R-02 外聘在基线上改过（缩小个人手机号遮蔽框并改原因）
          { id: 'R-02', baseVersion: 1, page: 1, x: 0.50, y: 0.43, width: 0.22, height: 0.05, reason: '个人手机号（外聘缩框）', privilege: '个人信息', status: 'confirmed' },
          // 外聘新绘制区域
          { id: 'R-10', baseVersion: 0, page: 2, x: 0.10, y: 0.52, width: 0.42, height: 0.05, reason: '银行账号摘录', privilege: '财务信息', status: 'confirmed' }
        ],
        reviews: [
          {
            check: '全文禁词与姓名复核',
            status: 'signed',
            operator: '沈确（外聘复核员）',
            reviewNo: 'REV-EXT-7031',
            basis: { docVersion: 1, regionSeq: 1, classification: '严格机密' },
            conclusion: '禁词扫描通过，新增账号区域已遮蔽',
            signedAt: '09-29 17:40'
          }
        ]
      },
      {
        docId: 'DOC-00427',
        docVersion: 3,
        regionVersion: 2,
        // 外聘离线基线时中心密级为「机密」v2；外聘离线期间改成「内部」，
        // 而中心同期改成了「严格机密」→ 密级两边都改过
        classification: '内部',
        classVersion: 2,
        baseClassification: '机密',
        baseClassVersion: 2,
        redactions: [
          { id: 'R-04', baseVersion: 2, page: 1, x: 0.08, y: 0.69, width: 0.60, height: 0.05, reason: '内部调查意见（外聘缩框）', privilege: '工作成果', status: 'confirmed' }
        ],
        reviews: [
          {
            check: '图像边界残片',
            status: 'signed',
            operator: '沈确（外聘复核员）',
            reviewNo: 'REV-EXT-7032',
            basis: { docVersion: 3, regionSeq: 2, classification: '机密' },
            conclusion: '遮蔽边界 2mm 区域无残片',
            signedAt: '09-29 17:41'
          }
        ]
      }
    ]
  };
}
