// 技能管理整页:安装(粘贴/导入 SKILL.md)、编辑(重组原文回填)、启停、删除。
// 结构:吸顶头部 + 直接铺开的技能列表 + 右下角悬浮球;点悬浮球(或行内「编辑」)
// 弹出底部浮层填写/保存。数据经 SKILL_* 消息走后台(skillClient),不碰 IDB。
// 行内布局:开关独占行尾(最高频操作),「编辑/删除」在行内独立动作行常驻显示
// —— 悬停才显形的操作在桌面端可发现性差,与开关挤同区也会误触。

import { useEffect, useRef, useState } from "react";
import { createLogger } from "../../shared/logger";
import { skillReq, skillRawReq } from "../clients/skillClient";
import { MSG, type SkillInfo } from "../../shared/messages";
import { useConfirmDelete, useT } from "../ui/hooks";
import { SubPageEmpty } from "../ui/SubPageEmpty";
import SkeletonRows from "../ui/SkeletonRows";
import SubPageHeader from "../ui/SubPageHeader";
import { PencilIcon, TrashIcon } from "../ui/icons";

const log = createLogger({ ctx: "panel" });

/** 浮层形态:添加(空草稿)/ 编辑(取回重组原文回填)共用同一张卡 */
type SkillEditor = { mode: "add" } | { mode: "edit"; id: string };

export default function SkillView({
  onBack,
  backLabel,
}: {
  onBack: () => void;
  /** 返回钮文案随来路:设置页入口「返回设置」,聊天入口由 App 传「返回对话」 */
  backLabel?: string;
}) {
  const t = useT();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  // 浮层(添加/编辑共用):draft 为 SKILL.md 原文,editorError 就地展示
  const [editor, setEditor] = useState<SkillEditor | null>(null);
  const [draft, setDraft] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  // 编辑态原文经 SKILL_RAW 异步取回,取回前 textarea 呈加载态(不留空窗闪帧)
  const [editLoading, setEditLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 请求序号守卫(硬规则 10,同 useAgentChannel 的 actionSeq):连点两条
  // 技能时先点的请求可能后回,迟到的原文若仍回填,会把 A 的内容存进 B
  // (save 用 editor.id + 当前 draft)。每次 startEdit 取递增序号,回包
  // 过期即丢弃;关闭/切添加同样递增,作废全部在途请求。渲染期不写 ref
  const editSeqRef = useRef(0);

  useEffect(() => {
    skillReq({ type: MSG.SKILL_LIST })
      .then((r) => setSkills(r.skills))
      .catch(() => setSkills([])); // 加载失败按空列表呈现,重开页面重试
  }, []);

  const startAdd = () => {
    editSeqRef.current++;
    setDraft("");
    setEditorError(null);
    setEditor({ mode: "add" });
  };

  const startEdit = async (s: SkillInfo) => {
    const seq = ++editSeqRef.current;
    setDraft("");
    setEditorError(null);
    setEditor({ mode: "edit", id: s.id });
    setEditLoading(true);
    try {
      const { raw } = await skillRawReq(s.id);
      if (seq !== editSeqRef.current) return; // 迟到的回包:编辑器已指向别条/已关闭
      if (raw === undefined) {
        setEditorError(t("skills.gone"));
        return;
      }
      setDraft(raw);
    } catch {
      if (seq !== editSeqRef.current) return;
      setEditorError(t("skills.gone"));
    } finally {
      if (seq === editSeqRef.current) setEditLoading(false);
    }
  };

  const closeEditor = () => {
    editSeqRef.current++; // 作废在途原文请求:关掉后迟到的回包不再回填
    setEditor(null);
    setDraft("");
    setEditorError(null);
  };

  const save = async () => {
    if (!editor || !draft.trim()) return;
    const req =
      editor.mode === "add"
        ? { type: MSG.SKILL_ADD, raw: draft }
        : { type: MSG.SKILL_UPDATE, id: editor.id, raw: draft };
    try {
      const r = await skillReq(req);
      setSkills(r.skills);
      if (r.error) {
        setEditorError(r.error);
        return;
      }
      closeEditor();
    } catch (e) {
      log.error("skills", "技能保存请求失败", { err: String(e) });
      setEditorError(String(e));
    }
  };

  const toggle = async (s: SkillInfo) => {
    try {
      const r = await skillReq({
        type: MSG.SKILL_TOGGLE,
        id: s.id,
        enabled: !s.enabled,
      });
      setSkills(r.skills);
    } catch (e) {
      log.error("skills", "技能启停失败", { err: String(e) });
    }
  };

  const { confirmingId, remove } = useConfirmDelete<string>((id) => {
    if (editor?.mode === "edit" && editor.id === id) closeEditor();
    setSkills((list) => list?.filter((s) => s.id !== id) ?? list);
    skillReq({ type: MSG.SKILL_DELETE, id })
      .then((r) => setSkills(r.skills))
      .catch(() => {}); // 乐观移除后兜底刷新
  });

  const importFile = async (file: File) => {
    try {
      setDraft(await file.text());
      setEditorError(null);
    } catch {
      setEditorError(t("skills.readFailed"));
    }
  };

  return (
    <div className="view-in relative flex min-h-0 flex-1 flex-col">
      <SubPageHeader
        title={t("skills.title")}
        onBack={onBack}
        backLabel={backLabel ?? t("skills.backToSettings")}
      />

      <div className="mx-auto w-full max-w-[560px] min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
        {skills === null ? (
          <SkeletonRows widths={[76, 58, 68]} />
        ) : skills.length === 0 ? (
          <SubPageEmpty
            icon={
              <>
                <path d="M6 3h9l4 4v14H6z" />
                <path d="M14 3v5h5" />
                <path d="M9 13h7M9 17h5" />
              </>
            }
            title={t("skills.empty")}
            hint={t("skills.emptyHint")}
          />
        ) : (
          <ul className="m-0 list-none space-y-0.5 p-0">
            {skills.map((s) => (
              <SkillRow
                key={s.id}
                skill={s}
                confirming={confirmingId === s.id}
                onEditStart={() => void startEdit(s)}
                onToggle={() => void toggle(s)}
                onRemove={() => remove(s.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 悬浮球:页内唯一「添加技能」入口;浮层打开期间让位隐藏 */}
      {!editor && (
        <button
          type="button"
          aria-label={t("skills.add")}
          onClick={startAdd}
          className="icon-btn-filled absolute right-4 bottom-4 z-20 h-10 w-10 shadow-2"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
        </button>
      )}

      {/* 添加/编辑浮层:底部锚定卡 + 垫层,Esc/垫层点击/取消都可关 */}
      {editor && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 浮层垫层(scrim),标准模式 */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: 垫层仅服务指针,键盘经 Esc 关闭(见下) */}
          <div className="fixed inset-0 z-10" onClick={closeEditor} />
          <div
            role="dialog"
            aria-label={editor.mode === "add" ? t("skills.add") : t("skills.edit")}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeEditor();
              }
            }}
            className="settings-card absolute inset-x-3 bottom-3 z-20 shadow-2"
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={editLoading ? t("skills.editLoading") : t("skills.placeholder")}
              aria-label={editor.mode === "add" ? t("skills.add") : t("skills.edit")}
              disabled={editLoading}
              spellCheck={false}
              rows={8}
              // biome-ignore lint/a11y/noAutofocus: 点「添加/编辑」即弹出即写,自动聚焦是产品语义
              autoFocus
              className="field-input block w-full resize-y font-mono text-[12px] leading-5"
            />
            {editorError && <p className="field-hint text-error">{editorError}</p>}
            <div className="flex items-center gap-2 pt-1">
              {editor.mode === "add" && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="btn-text muted mr-auto"
                >
                  {t("skills.importFile")}
                </button>
              )}
              <button
                type="button"
                onClick={closeEditor}
                className={`btn-text muted ${editor.mode === "add" ? "" : "ml-auto"}`}
              >
                {t("skills.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!draft.trim()}
                className="btn-text"
              >
                {t("skills.save")}
              </button>
            </div>
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".md,text/markdown,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.target.value = ""; // 重置:同一文件可再次选择
        }}
      />
    </div>
  );
}

// ---- 行 ----

function SkillRow({
  skill: s,
  confirming,
  onEditStart,
  onToggle,
  onRemove,
}: {
  skill: SkillInfo;
  confirming: boolean;
  onEditStart: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <li className="skill-row-in">
      <div className="rounded-md px-2 py-2 transition-colors duration-150 hover:bg-on-surface/8">
        {/* 首行:名称 + 开关独占行尾(最高频操作,不需悬停) */}
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-[13px] leading-5 text-on-surface">
            /{s.name}
            {!s.enabled && (
              <span className="skill-badge">{t("common.disabled")}</span>
            )}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={s.enabled}
            aria-label={s.enabled ? t("skills.disable") : t("skills.enable")}
            title={s.enabled ? t("skills.disable") : t("skills.enable")}
            onClick={onToggle}
            className="switch"
          >
            <span className="switch-knob" />
          </button>
        </div>
        <span className="skill-desc">{s.description}</span>
        {/* 动作行:编辑/删除常驻显示,与开关分区分行(悬停显形已废弃) */}
        <div className="mt-0.5 flex items-center gap-1">
          <button
            type="button"
            aria-label={t("skills.edit")}
            onClick={onEditStart}
            className="model-row-action gap-1"
          >
            <PencilIcon />
            {t("skills.edit")}
          </button>
          {confirming ? (
            <button
              type="button"
              aria-label={t("common.confirmDelete")}
              onClick={onRemove}
              className="model-row-action model-row-action-danger gap-1 font-semibold"
            >
              {t("common.confirmDelete")}
            </button>
          ) : (
            <button
              type="button"
              aria-label={t("skills.deleteOne")}
              onClick={onRemove}
              className="model-row-action model-row-action-danger gap-1"
            >
              <TrashIcon />
              {t("skills.deleteOne")}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
