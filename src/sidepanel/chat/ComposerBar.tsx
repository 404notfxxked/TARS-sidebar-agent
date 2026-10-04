// 输入区:附件条、/ 技能菜单、自增高 textarea、模型/思考选择器与发送/停止。
// 只收 props —— port 订阅(useAgentChannel)仍归 ChatView 唯一持有。

import { useLayoutEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SkillInfo } from "../../shared/messages";
import type { ConfirmLevel, ProviderEntry } from "../../shared/configStore";
import type { PendingImage } from "./images";
import ConfirmLevelPill from "./ConfirmLevelPill";
import ModelPicker from "./ModelPicker";
import ThinkingPicker from "./ThinkingPicker";
import SkillMenu from "./SkillMenu";
import { ArrowUpIcon, ImageIcon, StopIcon } from "../ui/icons";
import { useT } from "../ui/hooks";

/** 附件条依赖(useAttachments 的产出 + 文件选择入口) */
export interface ComposerAttachments {
  pendingImages: PendingImage[];
  attachHint: string;
  removePending: (id: string) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** 文件选择确认:统一走附件入口(门控/限量/压缩在 useAttachments) */
  onPickFiles: (files: File[]) => void;
  visionOk: boolean;
}

/** / 技能菜单依赖(useSkillMenu 的产出) */
export interface ComposerSkills {
  list: SkillInfo[] | null;
  enabled: SkillInfo[];
  matches: SkillInfo[];
  query: string;
  open: boolean;
  activeIndex: number;
  setActiveIndex: Dispatch<SetStateAction<number>>;
  onClose: (v: boolean) => void;
  onPick: (name: string) => void;
  /** / 菜单空态引导 → 技能管理整页 */
  onManage: () => void;
}

/** 模型与思考档位依赖(useChatModels 的产出) */
export interface ComposerModels {
  providers: ProviderEntry[];
  providerId: string;
  modelId: string;
  onPick: (providerId: string, id: string) => void;
  showThinking: boolean;
  thinkingOptions: string[] | null;
  thinkingDefault: string | undefined;
  /** 当前模型已保存的思考档位(未设置 = 用目录折中默认档) */
  reasoningEffort?: string;
  onPickThinking: (effort: string | undefined) => void;
}

/** 确认档位依赖(useConfirmLevel 的产出):pick 落库完成后才 resolve */
export interface ComposerConfirm {
  level: ConfirmLevel;
  pick: (level: ConfirmLevel) => void | Promise<void>;
}

export default function ComposerBar({
  input,
  setInput,
  onSubmit,
  onCancel,
  status,
  chatInputRef,
  attachments,
  skills,
  models,
  confirm,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  status: string;
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
  attachments: ComposerAttachments;
  skills: ComposerSkills;
  models: ComposerModels;
  confirm: ComposerConfirm;
}) {
  // 按域解构成原名:下面的 JSX 与键盘处理保持逐字不变
  const {
    pendingImages,
    attachHint,
    removePending,
    fileInputRef,
    onPickFiles,
    visionOk,
  } = attachments;
  const {
    list: skillList,
    enabled: enabledSkills,
    matches: skillMatches,
    query: slashQuery,
    open: slashMenuOpen,
    activeIndex: skillIdx,
    setActiveIndex: setSkillIdx,
    onClose: setSlashClosed,
    onPick: pickSkill,
    onManage: onManageSkills,
  } = skills;
  const {
    providers,
    providerId: modelProvider,
    modelId,
    onPick: pickModel,
    showThinking,
    thinkingOptions,
    thinkingDefault,
    reasoningEffort,
    onPickThinking: setThinkingEffort,
  } = models;
  const { level: confirmLevel, pick: pickConfirmLevel } = confirm;
  const t = useT();

  // ---- textarea 随内容自增高(封顶约 5 行,超出内部滚动) ----
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 稳定,input 变化触发重测高
  useLayoutEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto"; // 先收回再按内容撑开,才能正确收缩
    const h = Math.min(el.scrollHeight, 116);
    el.style.height = `${h}px`;
    // 未到上限不给滚动条,避免 height 追赶 scrollHeight 一帧内出现的幽灵滚动条
    el.style.overflowY = el.scrollHeight > 116 ? "auto" : "hidden";
  }, [input, chatInputRef]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="relative mx-auto mb-3 w-[calc(100%-24px)] max-w-[560px] rounded-lg bg-surface-container-high transition-colors duration-200 focus-within:bg-surface-container-highest"
    >
      {pendingImages.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3.5 pt-2">
          {pendingImages.map((p) => (
            <div key={p.id} className="group relative">
              <img
                src={p.url}
                alt={t("chat.pendingImageAlt", { w: p.w, h: p.h })}
                className="h-14 w-14 rounded-md object-cover"
              />
              <button
                type="button"
                onClick={() => removePending(p.id)}
                aria-label={t("chat.removeImage")}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-on-surface text-[10px] leading-none text-surface-container-high shadow-sm"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {attachHint && (
        <p className="px-3.5 pt-1.5 text-[12px] text-on-surface-variant">
          {attachHint}
        </p>
      )}
      {slashMenuOpen && (
        <SkillMenu
          skills={skillMatches}
          query={slashQuery}
          activeIndex={Math.min(skillIdx, Math.max(skillMatches.length - 1, 0))}
          loading={skillList === null}
          hasAny={enabledSkills.length > 0}
          onPick={pickSkill}
          onHover={setSkillIdx}
          onManage={onManageSkills}
        />
      )}
      <div className="px-3.5 pt-2">
        <textarea
          ref={chatInputRef}
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: 面板即输入的产品语义(见 CHANGELOG「输入区焦点」),非表单页
          autoFocus
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setSlashClosed(false);
          }}
          onKeyDown={(e) => {
            // 菜单开着时键盘优先导航/选中;Esc 只关菜单不冒泡关悬浮层
            if (slashMenuOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSkillIdx((i) => Math.min(i + 1, skillMatches.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSkillIdx((i) => Math.max(i - 1, 0));
                return;
              }
              if (
                (e.key === "Enter" || e.key === "Tab") &&
                !e.nativeEvent.isComposing &&
                skillMatches.length > 0
              ) {
                e.preventDefault();
                pickSkill(
                  skillMatches[Math.min(skillIdx, skillMatches.length - 1)]
                    .name,
                );
                return;
              }
              if (e.key === "Escape") {
                setSlashClosed(true);
                return;
              }
            }
            // 输入法组词中的 Enter 是确认候选词,不当作发送
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={t("chat.placeholder")}
          aria-label={t("chat.askInput")}
          // 运行中不禁用:等待期间预打下一问是高频动作,禁用会把焦点丢给
          // body;发送由按钮/submit() 的 status 门控拦住
          className="block w-full resize-none bg-transparent py-1 text-[13px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant"
        />
      </div>
      <div className="flex items-center gap-2 px-2 pb-2 pt-0.5">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(e) => {
            onPickFiles(Array.from(e.target.files ?? []));
            e.target.value = ""; // 重置:同一文件可再次选择
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label={t("chat.addImage")}
          title={visionOk ? t("chat.addImage") : t("chat.visionOffTitle")}
          className="icon-btn"
        >
          <ImageIcon />
        </button>
        {providers.some((p) => p.models.length > 0) && (
          <ModelPicker
            providers={providers}
            modelProvider={modelProvider}
            modelId={modelId}
            onPick={pickModel}
          />
        )}
        {showThinking && thinkingOptions && (
          <ThinkingPicker
            options={thinkingOptions}
            value={
              reasoningEffort ??
              thinkingDefault ??
              // 类型兜底:showThinking 已蕴含 options 非空,运行时不可达
              (thinkingOptions.includes("off") ? "off" : thinkingOptions[0])
            }
            onPick={setThinkingEffort}
          />
        )}
        <ConfirmLevelPill level={confirmLevel} pick={pickConfirmLevel} />
        {/* 发送/停止是同一个按钮:状态切换不换元素,焦点不掉(键盘用户
            停止后 space 仍是同一颗键)。36px 与 settings-btn 同高 —— M3
            Expressive 的研究实测更大的主动作键命中更快;箭头用 SVG 不用
            「↑」字形,字形光学尺寸随平台字体漂移。图标以 key 触发 msg-in
            轻浮升过渡,状态翻转有 250ms emphasized 的完成感 */}
        <button
          type={status === "idle" ? "submit" : "button"}
          onClick={status === "idle" ? undefined : onCancel}
          disabled={
            status === "idle" &&
            !input.trim() &&
            pendingImages.length === 0
          }
          aria-label={status === "idle" ? t("chat.send") : t("chat.stop")}
          className={`icon-btn-filled ml-auto h-9 w-9 ${
            status === "idle" ? "" : "error"
          }`}
        >
          <span
            key={status}
            className="msg-in flex items-center justify-center"
          >
            {status === "idle" ? <ArrowUpIcon /> : <StopIcon />}
          </span>
        </button>
      </div>
    </form>
  );
}
