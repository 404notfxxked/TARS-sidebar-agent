// 技能管理整页:安装(粘贴/导入 SKILL.md)、编辑(重组原文回填)、启停、删除。
// 结构沿用记忆页范式:吸顶头部 + 添加区 + 行悬停操作 + 两段确认删除;
// 数据经 SKILL_* 消息走后台(skillClient),本视图不碰 IDB。
// 与记忆页的差异:技能正文较大,编辑走「展开行 → textarea」而非行内单行输入。

import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import { createLogger } from "../../shared/logger";
import { skillReq, skillRawReq } from "../clients/skillClient";
import { MSG, type SkillInfo } from "../../shared/messages";
import { useConfirmReset } from "../ui/hooks";
import SkeletonRows from "../ui/SkeletonRows";
import SubPageHeader from "../ui/SubPageHeader";
import { TrashIcon } from "../ui/icons";

const log = createLogger({ ctx: "panel" });

export default function SkillView({ onBack }: { onBack: () => void }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  // 添加区:收起态只显示按钮;展开后是 SKILL.md 粘贴编辑器(导入文件同入口)
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // 行内编辑:点行展开,取回重组原文;保存失败错误就地展示
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
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
    try {
      const { raw } = await skillRawReq(s.id);
      if (raw === undefined) {
        setEditError(t("skills.gone"));
        return;
      }
      setEditDraft(raw);
    } catch {
      setEditError(t("skills.gone"));
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
        backLabel={t("skills.backToSettings")}
      />

      {/* 添加区:紧凑双钮(主动作 tonal + 次动作 outlined,左对齐不拉伸——
          桌面指针不需要移动端动作条的半宽大靶心)+ 可展开的粘贴编辑器 */}
      <div className="px-3 pb-1 pt-1">
        {!adding ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setAdding(true);
                setAddError(null);
              }}
              className="settings-btn tonal"
            >
              {t("skills.add")}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="settings-btn"
            >
              {t("skills.importFile")}
            </button>
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
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setDraft("");
                  setAddError(null);
                }}
                className="btn-text muted text-[12px]"
              >
                {t("skills.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void saveAdd()}
                disabled={!draft.trim()}
                className="btn-text text-[12px]"
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
        {skills !== null && skills.length > 0 && (
          <p className="mb-0 mt-1.5 px-1 text-[11px] leading-4 text-on-surface-variant">
            {t("skills.countLine", { n: skills.length })}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
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
  editError: string | null;
  confirming: boolean;
  onEditStart: () => void;
  onEditDraft: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="skill-row-in">
      <div className="group flex items-start gap-1 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-on-surface/8">
        <button
          type="button"
          onClick={onEditStart}
          title={t("skills.clickToEdit")}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="block font-mono text-[13px] leading-5 text-on-surface">
            /{s.name}
            {!s.enabled && (
              <span className="skill-badge">{t("common.disabled")}</span>
            )}
          </span>
          <span className="skill-desc">{s.description}</span>
          <span className="skill-desc opacity-70">
            {t("skills.chars", { n: s.chars })}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5">
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
              className="btn-text danger px-2 text-[11px]"
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
            spellCheck={false}
            rows={10}
            // biome-ignore lint/a11y/noAutofocus: 点「编辑」即展开即改,自动聚焦是产品语义
            autoFocus
            className="field-input block w-full resize-y font-mono text-[12px] leading-5"
          />
          {editError && <p className="field-hint text-error">{editError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onEditCancel} className="btn-text muted text-[12px]">
              {t("skills.cancel")}
            </button>
            <button
              type="button"
              onClick={onEditSave}
              disabled={!editDraft.trim()}
              className="btn-text text-[12px]"
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
      <p className="m-0 text-[11.5px] leading-4 text-on-surface-variant/80">
        {t("skills.emptyHint")}
      </p>
    </div>
  );
}
