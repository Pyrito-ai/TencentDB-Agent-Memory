import type { ReactNode } from 'react';
import { FilterToolbar, PageHeading } from '@/components/baren';
import './asset-page-header.css';

interface AssetPageHeaderProps {
  title: string;
  scope: ReactNode;
  agent?: ReactNode;
  actions?: ReactNode;
  subtitle?: string;
}

/**
 * 资产页共用头部。
 *
 * 仅负责统一标题、资产范围、Agent 筛选与操作栏的视觉编排；各资产页面仍自行维护
 * 数据请求、权限判断和按钮可用状态，避免把不同资产的业务语义耦合到通用组件中。
 */
export function AssetPageHeader({ title, scope, agent, actions, subtitle }: AssetPageHeaderProps) {
  return (
    <div className="_asset-page-header">
      <PageHeading
        title={title}
        description={subtitle}
        actions={actions && <div className="_asset-page-header-actions">{actions}</div>}
      />
      <FilterToolbar className="_asset-page-header-filters">
        {scope}
        {agent}
      </FilterToolbar>
    </div>
  );
}
