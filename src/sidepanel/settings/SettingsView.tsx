// 设置整页:分节组件的组装与共享的保存反馈,自己不再持有各域状态。
// 每个分节(settings/*Section.tsx)自治一个配置域,初始值来自这里的
// 一次 loadConfig —— 悬浮层每次打开都是新挂载,读时初始化无同步问题。
// 改动即自动保存的语义(契约):开关/下拉即时落盘,文本输入失焦落盘;
// 顶部「已保存」轻反馈由 run() 统一驱动,失败显示红色提示。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadConfig,
  selectedContextTokens,
  type AppConfig,
} from "../../shared/configStore";
import { t } from "../../shared/i18n";
import SubPageHeader from "../ui/SubPageHeader";
import ModelSection, { type ModelDomain } from "./ModelSection";
import AppearanceSection from "./AppearanceSection";
import WebSection from "./WebSection";
import McpSection from "./McpSection";
import MemorySection from "./MemorySection";
import SkillSection from "./SkillSection";
import CompactionSection from "./CompactionSection";
import DataSection from "./DataSection";
import DiagnosticsSection from "./DiagnosticsSection";

export default function SettingsView({
  onBack,
  onOpenMemory,
  onOpenSkills,
}: {
  onBack: () => void;
  /** 记忆摘要入口行 → 记忆管理整页(列表不长在这里:平铺时一节超一屏) */
  onOpenMemory: () => void;
  /** 技能管理入口行 → 技能整页(安装/编辑在整页做) */
  onOpenSkills: () => void;
}) {
  // 配置读齐才渲染分节:避免「默认空态闪一帧」;模型服务域(providers +
  // 当前引用)提升到这里,压缩用模型下拉要与它保持同源
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [domain, setDomain] = useState<ModelDomain | null>(null);
  // ── 保存反馈 ──
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const flashTimer = useRef<number | null>(null);

  const pingSaved = useCallback(() => {
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600);
  }, []);

  /** 统一落盘出口:成功闪「已保存」,失败亮红提示。经 props 下发全部分节 */
  const run = useCallback(
    async (p: Promise<void>) => {
      try {
        await p;
        setSaveError(false);
        pingSaved();
      } catch {
        setSaveError(true);
      }
    },
    [pingSaved],
  );

  useEffect(() => {
    loadConfig().then((c) => {
      setConfig(c);
      setDomain({
        providers: c.providers,
        modelProvider: c.modelProvider,
        model: c.model,
      });
    });
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  return (
    <div className="view-in flex min-h-0 flex-1 flex-col">
      <SubPageHeader title={t("settings.title")} onBack={onBack} className="px-4">
        <span
          aria-live="polite"
          className={`ml-auto pr-1 text-[11px] text-primary transition-opacity duration-300 ${
            savedFlash ? "opacity-100" : "opacity-0"
          }`}
        >
          {t("settings.saved")}
        </span>
      </SubPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {saveError && (
          <p className="mb-1 mt-2 text-[12px] text-error">
            {t("settings.saveFailed")}
          </p>
        )}

        {config && domain && (
          <>
            {/* ── 模型服务 ── */}
            <ModelSection
              domain={domain}
              onChange={setDomain}
              run={run}
            />

            {/* ── 外观 ── */}
            <AppearanceSection
              initialTheme={config.theme}
              initialAccent={config.accent}
              run={run}
            />

            {/* ── 联网 ── */}
            <WebSection initialWebSearch={config.webSearch} run={run} />

            {/* ── MCP:总开关 + 服务器卡片 ── */}
            <McpSection initial={config.mcp} run={run} />

            {/* ── 记忆:开关 + 摘要入口行;条目管理在记忆整页(MemoryView)── */}
            <MemorySection
              initialOn={config.memory}
              contextTokens={selectedContextTokens(config)}
              onOpenMemory={onOpenMemory}
              run={run}
            />

            {/* ── 技能:开关 + 管理入口行;安装在技能整页(SkillView)── */}
            <SkillSection
              initialOn={config.skills}
              onOpenSkills={onOpenSkills}
              run={run}
            />

            {/* ── 上下文压缩 ── */}
            <CompactionSection
              initialCompact={config.compact}
              initialRef={
                config.compactProvider && config.compactModel
                  ? `${config.compactProvider}||${config.compactModel}`
                  : ""
              }
              providers={domain.providers}
              run={run}
            />

            {/* ── 数据 ── */}
            <DataSection
              initialRetentionDays={config.historyRetention}
              run={run}
            />

            {/* ── 诊断 ── */}
            <DiagnosticsSection />
          </>
        )}
      </div>
    </div>
  );
}
