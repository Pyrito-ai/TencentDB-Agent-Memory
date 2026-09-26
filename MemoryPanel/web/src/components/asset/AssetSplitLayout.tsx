/**
 * AssetSplitLayout — 资产管理页通用分栏布局。
 *
 * 统一 Skills / Memory 等资产页的「左侧列表 + 右侧详情」分栏结构：
 * - 左右宽度可拖拽调节，比例记忆到 localStorage（同一浏览器下次保留）
 * - 两侧使用工作区提供的可用高度，窄内容区改为上下排列
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import './asset-split-layout.css';

interface AssetSplitLayoutProps {
  sidebar: ReactNode;
  detail: ReactNode;
  /** 拖拽宽度的持久化 key（不同页面互不干扰）；不传则不持久化 */
  storageKey?: string;
}

const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 480;
const DEFAULT_SIDEBAR = 280;

function clampWidth(w: number): number {
  return Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w));
}

function readStoredWidth(storageKey?: string): number {
  if (!storageKey) return DEFAULT_SIDEBAR;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_SIDEBAR;
  } catch {
    return DEFAULT_SIDEBAR;
  }
}

export function AssetSplitLayout({ sidebar, detail, storageKey }: AssetSplitLayoutProps) {
  const { t } = useTranslation();
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredWidth(storageKey));
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 拖拽过程：以容器左边界为基准计算左栏宽度，限制在 [MIN, MAX] 内
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setSidebarWidth(clampWidth(e.clientX - rect.left));
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // 拖拽时禁用文本选中，避免选到列表内容
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [dragging]);

  // 拖拽结束后持久化最终宽度
  useEffect(() => {
    if (dragging || !storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(sidebarWidth));
    } catch {
      /* localStorage 不可用时静默忽略，仅影响记忆能力 */
    }
  }, [dragging, sidebarWidth, storageKey]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`_asset-split${dragging ? ' _asset-split--dragging' : ''}`}
      style={{ '--asset-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <section className="_asset-split-sidebar">{sidebar}</section>
      <button
        type="button"
        className="_asset-split-resizer"
        aria-label={t('assetSplit.resizer.label')}
        onMouseDown={onHandleMouseDown}
        onKeyDown={(e) => {
          // 键盘可达：左右箭头以 16px 步进调整左栏宽度
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w - 16));
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w + 16));
          }
        }}
      >
        <span className="_asset-split-resizer-bar" />
      </button>
      <section className="_asset-split-detail">{detail}</section>
    </div>
  );
}
