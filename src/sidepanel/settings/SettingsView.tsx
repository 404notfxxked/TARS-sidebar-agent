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
import { useT } from "../ui/hooks";
import SubPageHeader from "../ui/SubPageHeader";
import { CheckIcon } from "../ui/icons";
import ModelSection, { type ModelDomain } from "./ModelSection";
import AppearanceSection from "./AppearanceSection";
import WebSection from "./WebSection";
import McpSection from "./McpSection";
import MemorySection from "./MemorySection";
import SkillSection from "./SkillSection";
import SecuritySection from "./SecuritySection";
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
  const t = useT();
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
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1200);
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
        {/* 保存反馈胶囊:自动保存的轻确认。空间常驻只做透明度过渡,
            顶栏不跳;连续改动由 1.2s 去抖只闪一次;失败态常驻到下次成功,
            且挂在顶栏(滚动区顶部的提示会随滚动离开视口,看不见) */}
        <span
          aria-live="polite"
          className={`save-flash ml-auto ${saveError ? "error" : savedFlash ? "show" : ""}`}
        >
          {!saveError && <CheckIcon />}
          {saveError ? t("settings.saveFailed") : t("settings.saved")}
        </span>
      </SubPageHeader>

      <div className="mx-auto w-full max-w-[560px] min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {config && domain && (
          <>
            {/* 分节顺序 = onboarding 叙事(README 快速开始的顺序):
                必配(模型)→ 通行证(安全)→ 能力开关(联网/MCP/记忆/技能)→
                进阶(压缩)→ 个性化(外观)→ 维护(数据/诊断)。
                分组本身(一节一配置域)不动,只调序 */}
            {/* ── 模型服务:没它产品不工作,恒第一 ── */}
            <ModelSection
              domain={domain}
              onChange={setDomain}
              run={run}
            />

            {/* ── 安全:页面/网络授权是读页/搜索/读网页的总闸(onboarding
                第 2 步),确认门决定 agent 自治程度 —— 曾排第 7,新用户
                按快速开始走要滚过 5 张卡才找到授权入口 ── */}
            <SecuritySection
              initialConfirmActions={config.confirmActions}
              initialNotifyDone={config.notifyDone}
              run={run}
            />

            {/* ── 能力开关集群:这个 agent 能做什么 ── */}
            {/* 联网 */}
            <WebSection
              initialWebSearch={config.webSearch}
              // anthropic-messages 供应商的搜索由服务商在服务端执行(不需要
              // 网页授权、不读结果页):联网分节据此对这类供应商隐去标签页通道
              // 专属的说明与授权提示
              serverSearch={
                config.providers.find((p) => p.id === config.modelProvider)?.kind ===
                "anthropic-messages"
              }
              run={run}
            />

            {/* MCP:总开关 + 服务器卡片 */}
            <McpSection initial={config.mcp} run={run} />

            {/* 记忆:开关 + 摘要入口行;条目管理在记忆整页(MemoryView)*/}
            <MemorySection
              initialOn={config.memory}
              contextTokens={selectedContextTokens(config)}
              onOpenMemory={onOpenMemory}
              run={run}
            />

            {/* 技能:开关 + 管理入口行;安装在技能整页(SkillView)*/}
            <SkillSection
              initialOn={config.skills}
              onOpenSkills={onOpenSkills}
              run={run}
            />

            {/* ── 上下文压缩:模型行为调优,跟能力开关更近,不与维护项混排 ── */}
            <CompactionSection
              initialCompact={config.compact}
              initialRef={
                config.compactProvider && config.compactModel
                  ? {
                      providerId: config.compactProvider,
                      modelId: config.compactModel,
                    }
                  : null
              }
              providers={domain.providers}
              run={run}
            />

            {/* ── 外观:低频个性化,让位给功能分节(曾排第 2,打断能力集群)── */}
            <AppearanceSection
              initialTheme={config.theme}
              initialAccent={config.accent}
              initialQuote={config.quote}
              run={run}
            />

            {/* ── 维护区:数据 / 诊断,恒底部 ── */}
            <DataSection
              initialRetentionDays={config.historyRetention}
              run={run}
            />

            <DiagnosticsSection />
          </>
        )}
      </div>
    </div>
  );
}
