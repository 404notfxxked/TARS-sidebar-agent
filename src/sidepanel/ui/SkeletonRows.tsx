// 列表加载骨架:两段灰条(标题 + 副行)按给定宽度序列重复。
// 历史会话页与记忆页共用;宽度是百分比数字,首行逐条不同、副行固定窄条。

export default function SkeletonRows({ widths }: { widths: number[] }) {
  return (
    <div className="space-y-4 px-2 pt-3" aria-hidden="true">
      {widths.map((w, i) => (
        <div key={i} className="animate-pulse space-y-1.5">
          <div
            className="h-3 rounded bg-surface-container-highest"
            style={{ width: `${w}%` }}
          />
          <div className="h-2 w-1/4 rounded bg-surface-container-highest" />
        </div>
      ))}
    </div>
  );
}
