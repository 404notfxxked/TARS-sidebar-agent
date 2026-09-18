// 技能管理整页:安装(粘贴/导入 SKILL.md)、编辑(重组原文回填)、启停、删除。
// 结构对齐记忆页范式:吸顶头部 + 常驻胶囊添加条 + 行悬停操作 + 两段确认删除;
// 数据经 SKILL_* 消息走后台(skillClient),本视图不碰 IDB。
// 与记忆页的差异:技能正文较大,编辑走「展开行 → textarea」而非行内单行输入;
// 编辑入口是行尾悬停显形的铅笔钮 —— 整行可点会与同区的开关/删除误触。

import { useEffect, useRef, useState } from "react";
import { createLogger } from "../../shared/logger";
import { skillReq, skillRawReq } from "../clients/skillClient";
import { MSG, type SkillInfo } from "../../shared/messages";
import { useConfirmReset, useT } from "../ui/hooks";
import SkeletonRows from "../ui/SkeletonRows";
import SubPageHeader from "../ui/SubPageHeader";
import { PencilIcon, TrashIcon } from "../ui/icons";

const log = createLogger({ ctx: "panel" });

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
  // 添加区:常驻胶囊条,点击展开 SKILL.md 粘贴编辑器(导入文件收在编辑器内)
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // 行内编辑:点铅笔展开,取回重组原文;保存失败错误就地展示
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  // 原文经 SKILL_RAW 异步取回,取回前 textarea 呈加载态(不留空窗闪帧)
  const [editLoading, setEditLoading] = useState(false);
  const [confirmDelId, armConfirmDel, resetConfirmDel] =
    useConfirmReset<string>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    skillReq({ type: MSG.SKILL_LIST })
      .then((r) => setSkills(r.skills))
      .catch(() => setSkills([])); // 加载失败按空列表呈现,重开页面重试
  }, []);

  const saveAdd = async () => {
    if (!draft.trim()) return;
    try {
      const r = await skillReq({ type: MSG.SKILL_ADD, raw: draft });
      setSkills(r.skills);
      if (r.error) {
        setAddError(r.error);
        return;
      }
      setDraft("");
      setAddError(null);
      setAdding(false);
    } catch (e) {
      log.error("skills", "技能导入请求失败", { err: String(e) });
      setAddError(String(e));
    }
  };

  const startEdit = async (s: SkillInfo) => {
    if (editingId === s.id) return;
    setAdding(false);
    setEditingId(s.id);
    setEditError(null);
    setEditDraft("");
    setEditLoading(true);
    try {
      const { raw } = await skillRawReq(s.id);
      if (raw === undefined) {
        setEditError(t("skills.gone"));
        return;
      }
      setEditDraft(raw);
    } catch {
      setEditError(t("skills.gone"));
    } finally {
      setEditLoading(false);
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      const r = await skillReq({
        type: MSG.SKILL_UPDATE,
        id: editingId,
        raw: editDraft,
      });
      setSkills(r.skills);
      if (r.error) {
        setEditError(r.error);
        return;
      }
      setEditingId(null);
      setEditError(null);
    } catch (e) {
      setEditError(String(e));
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

  const remove = (id: string) => {
    if (confirmDelId !== id) {
      armConfirmDel(id);
      return;
    }
    resetConfirmDel();
    if (editingId === id) setEditingId(null);
    setSkills((list) => list?.filter((s) => s.id !== id) ?? list);
    skillReq({ type: MSG.SKILL_DELETE, id })
      .then((r) => setSkills(r.skills))
      .catch(() => {}); // 乐观移除后兜底刷新
  };

  const importFile = async (file: File) => {
    try {
      setDraft(await file.text());
      setAddError(null);
      setAdding(true);
    } catch {
      setAddError(t("skills.readFailed"));
    }
  };

  return (
    <div className="view-in flex min-h-0 flex-1 flex-col">
      <SubPageHeader
        title={t("skills.title")}
        onBack={onBack}
        backLabel={backLabel ?? t("skills.backToSettings")}
      />

      {/* 添加区:常驻胶囊条(范式同记忆页添加条),点击展开粘贴编辑器 */}
      <div className="mx-auto w-full max-w-[560px] px-3 pb-1 pt-1">
        {!adding ? (
          <div className="relative">
            <button
              type="button"
              aria-label={t("skills.add")}
              onClick={() => {
                setAdding(true);
                setAddError(null);
              }}
              className="memory-add block cursor-pointer text-left"
            >
              <span className="opacity-65">{t("skills.placeholder")}</span>
            </button>
            {/* 装饰性加号:与记忆页添加钮同位同形;整条已可点,不单独交互 */}
            <span
              aria-hidden="true"
              className="icon-btn-filled pointer-events-none absolute right-[5px] top-1/2 h-[26px] w-[26px] -translate-y-1/2"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M8 3.5v9M3.5 8h9" />
              </svg>
            </span>
          </div>
        ) : (
          <div className="settings-card">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("skills.placeholder")}
              aria-label={t("skills.add")}
              spellCheck={false}
              rows={8}
              // biome-ignore lint/a11y/noAutofocus: 点「添加技能」即展开即写,自动聚焦是产品语义
              autoFocus
              className="field-input block w-full resize-y font-mono text-[12px] leading-5"
            />
            {addError && <p className="field-hint text-error">{addError}</p>}
            <div className="flex items-center gap-2 pt-1">
              {/* 导入文件是添加的次动作:收进编辑器左侧,不与主动作并排裸放 */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn-text muted mr-auto"
              >
                {t("skills.importFile")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setDraft("");
                  setAddError(null);
                }}
                className="btn-text muted"
              >
                {t("skills.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void saveAdd()}
                disabled={!draft.trim()}
                className="btn-text"
              >
                {t("skills.save")}
              </button>
            </div>
          </div>
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

      <div className="mx-auto w-full max-w-[560px] min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
        {skills === null ? (
          <SkeletonRows widths={[76, 58, 68]} />
        ) : skills.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="m-0 list-none space-y-0.5 p-0">
            {skills.map((s) => (
              <SkillRow
                key={s.id}
                skill={s}
                editing={editingId === s.id}
                editDraft={editingId === s.id ? editDraft : ""}
                editLoading={editLoading}
                editError={editingId === s.id ? editError : null}
                confirming={confirmDelId === s.id}
                onEditStart={() => void startEdit(s)}
                onEditDraft={setEditDraft}
                onEditSave={() => void saveEdit()}
                onEditCancel={() => {
                  setEditingId(null);
                  setEditError(null);
                }}
                onToggle={() => void toggle(s)}
                onRemove={() => remove(s.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- 行 ----

function SkillRow({
  skill: s,
  editing,
  editDraft,
  editLoading,
  editError,
  confirming,
  onEditStart,
  onEditDraft,
  onEditSave,
  onEditCancel,
  onToggle,
  onRemove,
}: {
  skill: SkillInfo;
  editing: boolean;
  editDraft: string;
  editLoading: boolean;
  editError: string | null;
  confirming: boolean;
  onEditStart: () => void;
  onEditDraft: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <li className="skill-row-in">
      <div className="group flex items-start gap-1 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-on-surface/8">
        {/* 名称与描述是纯展示:编辑走右侧铅笔,整行可点会误触展开编辑器 */}
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-[13px] leading-5 text-on-surface">
            /{s.name}
            {!s.enabled && (
              <span className="skill-badge">{t("common.disabled")}</span>
            )}
          </span>
          <span className="skill-desc">{s.description}</span>
        </div>
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={t("skills.edit")}
            title={t("skills.edit")}
            onClick={onEditStart}
            className="icon-btn text-on-surface-variant opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-on-surface"
          >
            <PencilIcon />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={s.enabled}
            aria-label={
              s.enabled ? t("skills.disable") : t("skills.enable")
            }
            title={s.enabled ? t("skills.disable") : t("skills.enable")}
            onClick={onToggle}
            className="switch"
          >
            <span className="switch-knob" />
          </button>
          {confirming ? (
            <button
              type="button"
              aria-label={t("common.confirmDelete")}
              onClick={onRemove}
              className="btn-text danger px-2 text-[12px]"
            >
              {t("common.confirmDelete")}
            </button>
          ) : (
            <button
              type="button"
              aria-label={t("skills.deleteOne")}
              title={t("skills.deleteOne")}
              onClick={onRemove}
              className="icon-btn text-on-surface-variant opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-error"
            >
              <TrashIcon />
            </button>
          )}
        </span>
      </div>
      {editing && (
        <div className="settings-card mt-1">
          <textarea
            value={editDraft}
            onChange={(e) => onEditDraft(e.target.value)}
            aria-label={t("skills.edit")}
            placeholder={editLoading ? t("skills.editLoading") : undefined}
            disabled={editLoading}
            spellCheck={false}
            rows={10}
            // biome-ignore lint/a11y/noAutofocus: 点「编辑」即展开即改,自动聚焦是产品语义
            autoFocus
            className="field-input block w-full resize-y font-mono text-[12px] leading-5"
          />
          {editError && <p className="field-hint text-error">{editError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onEditCancel} className="btn-text muted">
              {t("skills.cancel")}
            </button>
            <button
              type="button"
              onClick={onEditSave}
              disabled={!editDraft.trim()}
              className="btn-text"
            >
              {t("skills.save")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ---- 空态 ----

function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <svg
        width="30"
        height="30"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="text-on-surface-variant opacity-60"
      >
        <path d="M6 3h9l4 4v14H6z" />
        <path d="M14 3v5h5" />
        <path d="M9 13h7M9 17h5" />
      </svg>
      <p className="m-0 text-[13px] text-on-surface-variant">{t("skills.empty")}</p>
      <p className="m-0 text-[12px] leading-4 text-on-surface-variant/80">
        {t("skills.emptyHint")}
      </p>
    </div>
  );
}
