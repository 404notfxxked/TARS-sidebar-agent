// 对话视图:渲染与输入区。agent 状态(port 事件、消息、会话游标、本轮
// 执行流)在 chat/useAgentChannel;执行流状态机在 chat/useRunSegments,
// 过程卡渲染在 chat/trace,气泡与 markdown 在 chat/bubbles,图片管线与
// 缓存在 chat/images,空态(问候/chips/每日一句)在 chat/EmptyState,
// 写操作确认卡在 chat/ConfirmCard。

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { MSG, type SkillInfo } from "../../shared/messages";
import { parseSkillInvocation } from "../../shared/skills";
import {
  loadConfig,
  savePrefs,
  type ProviderEntry,
} from "../../shared/configStore";
import {
  defaultThinkingEffort,
  loadCatalog,
  thinkingOptionsOf,
  type Catalog,
} from "../../shared/modelCatalog";
import { createLogger } from "../../shared/logger";
import {
  MAX_ATTACHMENTS,
  cacheImgUrl,
  compressImage,
  ownsImgUrl,
  releaseAllImgUrls,
  type PendingImage,
} from "./images";
import { ReplayProcessCard, RunZone } from "./trace";
import {
  AssistantBubble,
  CompactionDivider,
  ErrorBubble,
  NoticeBubble,
  UserBubble,
} from "./bubbles";
import ModelPicker from "./ModelPicker";
import LanguageMenu from "./LanguageMenu";
import ThinkingPicker from "./ThinkingPicker";
import SkillMenu from "./SkillMenu";
import { ConfirmCard } from "./ConfirmCard";
import { EmptyState } from "./EmptyState";
import { useAgentChannel } from "./useAgentChannel";
import { skillReq } from "../clients/skillClient";
import { useT } from "../ui/hooks";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  HistoryIcon,
  ImageIcon,
  PlusIcon,
  SettingsIcon,
  StopIcon,
} from "../ui/icons";

const log = createLogger({ ctx: "panel" });

export default function ChatView({
  onOpenSettings,
  onOpenSessions,
  onOpenMemory,
  onOpenSkills,
  resumeSessionId,
  onResumeDone,
  onActiveSessionChange,
  chatInputRef,
}: {
  onOpenSettings: () => void;
  onOpenSessions: () => void;
  /** 轻提示直通记忆管理页(不经设置页中转,同 ChatGPT「Memory updated」) */
  onOpenMemory: () => void;
  /** / 菜单空态引导 → 技能管理整页 */
  onOpenSkills: () => void;
  /** 历史列表选中的会话:非空时打开它,完事后回调置空 */
  resumeSessionId: string | null;
  onResumeDone: () => void;
  /** 当前会话变化时回传 App,历史列表据此高亮「当前」 */
  onActiveSessionChange?: (sessionId: string) => void;
  /** 输入框 ref:App 持有,悬浮层关闭/一轮收口后把焦点还给输入框 */
  chatInputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const chat = useAgentChannel({ resumeSessionId, onResumeDone });
  const {
    messages,
    compaction,
    memorySaved,
    status,
    confirmReq,
    currentSession,
    runSegs,
    runPhase,
    runEndedAt,
    openGroups,
    toggleGroup,
  } = chat;

  /** 空态每日一句展示开关(设置 → 外观;storage 事件实时跟随) */
  const [quoteEnabled, setQuoteEnabled] = useState(true);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  // 切会话时清空输入草稿与待发附件:为 A 会话贴的图不该在 B 会话里发出
  // (预览 objectURL 一并回收);上一屏气泡的图片 URL 也在此时回收(新会话
  // 的图缺缓存会重新走 GET_IMAGE)。「新对话」按钮的清空在调用点自理。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随 resumeSessionId 触发,clearAttachments 读 ref + 稳定 setter,无过期闭包问题
  useEffect(() => {
    if (resumeSessionId !== null) {
      setInput("");
      clearAttachments();
      releaseAllImgUrls();
    }
  }, [resumeSessionId]);

  // ---- 模型选择:按供应商分组展示,切换即写回 modelProvider + model 两字段 ----
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [modelProvider, setModelProvider] = useState("");
  const [modelId, setModelId] = useState("");
  /** 当前供应商(选择器与视觉门控都基于它;引用失效时退回第一个) */
  const curProvider =
    providers.find((p) => p.id === modelProvider) ?? providers[0];
  const curModels = curProvider?.models ?? [];
  /** 当前模型是否支持视觉:图片入口的门控依据 */
  const visionOk = !!curModels.find((m) => m.id === modelId)?.vision;

  // ---- 思考程度:总开关(设置→推理)开着且目录有档位时,输入行出选择器 ----
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    loadCatalog()
      .then(setCatalog)
      .catch(() => {}); // 目录层缺失不算错误,按钮不出现即可
  }, []);
  const curModelEntry = providers
    .find((p) => p.id === modelProvider)
    ?.models.find((m) => m.id === modelId);
  const thinkingOptions =
    catalog && curModelEntry
      ? thinkingOptionsOf(catalog, curModelEntry.id)
      : null;
  // 未设置时显示与实际发送一致的折中默认档(defaultThinkingEffort)
  const thinkingDefault =
    catalog && curModelEntry
      ? defaultThinkingEffort(catalog, curModelEntry.id)
      : undefined;
  const showThinking = curModelEntry?.reasoning === true && !!thinkingOptions;
  const setThinkingEffort = (effort: string | undefined) => {
    const p = providers.find((x) => x.id === modelProvider);
    if (!p) return;
    const nextProviders = providers.map((x) =>
      x.id === p.id
        ? {
            ...x,
            models: x.models.map((m) =>
              m.id === modelId ? { ...m, reasoningEffort: effort } : m,
            ),
          }
        : x,
    );
    setProviders(nextProviders);
    savePrefs({ providers: nextProviders }).catch((err) =>
      log.warn("chat", "save thinking effort failed", { error: String(err) }),
    );
  };

  // ---- 图片附件状态 ----
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachHint, setAttachHint] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hintTimer = useRef<number | null>(null);
  // 附件的准入判定镜(ref):压缩/提交/清空都经这里同步,异步粘贴并发下
  // 余量判定才有最新值(state 闭包只反映上次渲染)
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const commitPendingImages = (next: PendingImage[]) => {
    pendingImagesRef.current = next;
    setPendingImages(next);
  };

  // 当前会话回传给 App,历史列表据此高亮「当前」
  useEffect(() => {
    onActiveSessionChange?.(currentSession);
  }, [currentSession, onActiveSessionChange]);

  // 挂载:读配置。设置页悬浮关闭后不重挂,配置变更靠 storage 事件同步模型列表
  useEffect(() => {
    const onStorage = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") return;
      if (changes.providers && Array.isArray(changes.providers.newValue)) {
        setProviders(
          (changes.providers.newValue as ProviderEntry[]).filter(
            (p) => p && typeof p.id === "string" && Array.isArray(p.models),
          ),
        );
      }
      if (
        changes.modelProvider &&
        typeof changes.modelProvider.newValue === "string"
      ) {
        setModelProvider(changes.modelProvider.newValue);
      }
      if (changes.model && typeof changes.model.newValue === "string") {
        setModelId(changes.model.newValue);
      }
      if (changes.quote && typeof changes.quote.newValue === "boolean") {
        setQuoteEnabled(changes.quote.newValue);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    loadConfig().then((c) => {
      setProviders(c.providers);
      setModelProvider(c.modelProvider);
      setModelId(c.model);
      setQuoteEnabled(c.quote);
    });
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
    };
  }, []);

  /** 切换默认模型:写供应商 + 模型两个字段,后台每轮 run 重读配置,下一轮生效 */
  const pickModel = (providerId: string, id: string) => {
    setModelProvider(providerId);
    setModelId(id);
    savePrefs({ modelProvider: providerId, model: id }).catch((err) =>
      log.warn("chat", "save model pref failed", { error: String(err) }),
    );
  };

  // 近底跟随:流式新内容只在用户本就位于底部附近时才拽底;
  // 上翻回看即暂停(scroll 事件解除 pinned),滚回底部自动恢复跟随。
  // 展开收起思考行/工具行不再经过 runSegs,不会触发这里。
  // atBottom 是同阈值的渲染态:离开底部时展示「回到最新」悬浮钮
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // 「回到最新」点击后的跟随意图:平滑滚动途中内容继续增长时,平滑重定标到
  // 新底而不是停在点击时刻的旧底;到底即清,用户主动上滚(scrollTop 回退)也清
  const followIntentRef = useRef(0);
  const lastTopRef = useRef(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (el.scrollTop < lastTopRef.current) followIntentRef.current = 0;
      lastTopRef.current = el.scrollTop;
      if (near) followIntentRef.current = 0;
      pinnedRef.current =
        near || Date.now() - followIntentRef.current < 2000;
      setAtBottom(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 随内容增长重跑,实现近底跟随
  useEffect(() => {
    const el = listRef.current;
    if (!el || !pinnedRef.current) return;
    // 跟随意图窗口内(刚点过「回到最新」)平滑重定标,日常流式仍直接贴底
    if (Date.now() - followIntentRef.current < 2000) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, runSegs, status]);

  // 「回到最新」:平滑滚回底部,滚动途中内容增长由跟随意图接手
  const scrollToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    followIntentRef.current = Date.now();
    pinnedRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // 一轮收口后若焦点已落在 body(停止钮卸载、悬浮层刚关等),把焦点还给
  // 输入框:下一问是收口后的高频动作,不该让用户再点一次输入框。
  // 放在渲染后执行,才能看到停止钮卸载后的最终焦点归属
  useEffect(() => {
    if (status === "idle" && document.activeElement === document.body) {
      chatInputRef.current?.focus();
    }
  }, [status, chatInputRef]);

  // ---- / 技能菜单:输入以 / 开头(仅起始位置)时触发 ----
  // 触发判定走 input 值而非 keydown:避开中文组词中间态;全角 ／ 不触发。
  // 清单带 3s TTL 缓存,菜单开着才取(SW 全量列表,轻请求;技能页改动后
  // 最多 3s 自愈)
  const [skillList, setSkillList] = useState<SkillInfo[] | null>(null);
  const skillFetchedAtRef = useRef(0);
  const [slashClosed, setSlashClosed] = useState(false); // Esc 关闭,输入变化后重开
  const [skillIdx, setSkillIdx] = useState(0);
  const slashMatch = /^\/([A-Za-z0-9_-]*)$/.exec(input);
  const slashQuery = slashMatch?.[1] ?? "";
  const enabledSkills = (skillList ?? []).filter((s) => s.enabled);
  const skillMatches = (() => {
    const q = slashQuery.toLowerCase();
    if (!q) return enabledSkills;
    return enabledSkills.filter(
      (s) => s.name.includes(q) || s.description.toLowerCase().includes(q),
    );
  })();
  // 输入变化 → 高亮回到首项(菜单开着时每次改词都重置选择)
  // biome-ignore lint/correctness/useExhaustiveDependencies: setSkillIdx 是稳定 setState
  useEffect(() => setSkillIdx(0), [slashQuery]);
  const slashMenuOpen = !!slashMatch && !slashClosed;

  useEffect(() => {
    if (!slashMenuOpen || Date.now() - skillFetchedAtRef.current < 3_000) return;
    skillFetchedAtRef.current = Date.now();
    skillReq({ type: MSG.SKILL_LIST })
      .then((r) => setSkillList(r.skills))
      .catch(() => {
        skillFetchedAtRef.current = 0; // 失败不缓存,下次触发重取
      });
  }, [slashMenuOpen]);

  /** 选中技能:回填 token + 尾随空格(空格使 input 不再匹配 / 形态,菜单随之关闭) */
  const pickSkill = (name: string) => {
    setInput(`/${name} `);
    setSlashClosed(false);
    setSkillIdx(0);
  };

  // ---- 输入区:textarea 随内容自增高(封顶约 5 行,超出内部滚动) ----
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

  /** 清空待发附件(切会话/新对话/发送后):预览 objectURL 一并回收。
   *  已交棒给气泡缓存的(发送出去的图)不在这里撤:气泡的 <img> 是重渲染时
   *  才创建的,此刻撤销会让它加载失败(浏览器对「先撤销、后新建元素」必失败),
   *  那批 URL 的生命周期随之归消息列表 —— 切会话/新对话时由 releaseAllImgUrls
   *  统一回收 */
  const clearAttachments = () => {
    for (const p of pendingImagesRef.current) {
      if (!ownsImgUrl(p.id)) URL.revokeObjectURL(p.url);
    }
    commitPendingImages([]);
    setAttachHint("");
  };

  const flashHint = (msg: string) => {
    setAttachHint(msg);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setAttachHint(""), 3000);
  };

  /** 图片附件统一入口(文件选择/粘贴都走这里):门控 → 限量 → 解码压缩。
   *  异步逐张处理,解不出的格式逐张提示,不影响其他图 */
  const addAttachments = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    if (!visionOk) {
      flashHint(t("chat.visionOffToast"));
      return;
    }
    // 余量判定读 ref 镜像(压缩前后各查一次):压缩是几十毫秒的异步,两次
    // 快速粘贴若各按调用时的 state 闭包算余量,会一起通过门控突破上限
    const added: PendingImage[] = [];
    let dropped = 0;
    for (const file of images) {
      if (pendingImagesRef.current.length + added.length >= MAX_ATTACHMENTS) {
        dropped = images.length - added.length;
        break;
      }
      let img: PendingImage;
      try {
        img = await compressImage(file);
      } catch {
        flashHint(t("chat.imageDecodeFailed", { name: file.name || t("chat.clipboard") }));
        continue;
      }
      if (pendingImagesRef.current.length + added.length >= MAX_ATTACHMENTS) {
        dropped = images.length - added.length;
        break;
      }
      added.push(img);
    }
    if (added.length > 0) {
      commitPendingImages([...pendingImagesRef.current, ...added]);
    }
    if (dropped > 0) {
      flashHint(
        added.length > 0
          ? t("chat.imageRoom", { room: added.length })
          : t("chat.imageLimit", { max: MAX_ATTACHMENTS }),
      );
    }
  };

  const removePending = (id: string) => {
    commitPendingImages(pendingImagesRef.current.filter((p) => {
      if (p.id !== id) return true;
      URL.revokeObjectURL(p.url);
      return false;
    }));
  };

  // 粘贴监听只在挂载时注册一次,addAttachments 闭包随渲染刷新 → ref 转发。
  // 监听在 document 级:用户截完图焦点常不在输入框。只在剪贴板真有图片时
  // preventDefault,普通文字粘贴不受影响
  const addAttachmentsRef = useRef(addAttachments);
  addAttachmentsRef.current = addAttachments;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      e.preventDefault();
      void addAttachmentsRef.current(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const submit = async () => {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || status !== "idle") return;
    // /token 命中已停用技能:提示但不拦截(SW 侧同样只认启用,原样透传)
    const inv = parseSkillInvocation(text);
    if (inv && skillList) {
      const hit = skillList.find(
        (s) => !s.enabled && s.name === inv.name.toLowerCase(),
      );
      if (hit) flashHint(t("skills.disabledHint", { name: hit.name }));
    }
    // 附件是开着视觉模型时贴的、发送前切到了非视觉模型:照常发送(图片仍会
    // 入库,切回视觉模型后可继续引用),但明确告知本次模型看不到
    if (pendingImages.length > 0 && !visionOk) {
      flashHint(
        t("chat.visionModelFallback"),
      );
    }
    // 会话全局唯一;tabId 记录本次提问的页面上下文(工具去该 tab 执行)
    const { tabId, sessionId } = await chat.resolveContext();
    log.info("chat", "submit", {
      text,
      sessionId,
      tabId,
      images: pendingImages.length,
    });
    // 本地回显:预览 url 先入气泡缓存,渲染无需再向后台取字节
    for (const p of pendingImages) cacheImgUrl(p.id, p.url);
    chat.submitUserMessage({
      sessionId,
      tabId,
      text,
      ...(pendingImages.length ? { images: pendingImages } : {}),
    });
    setInput("");
    clearAttachments();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 会话操作(历史/新建)居左、全局设置居右:高频对象操作占视线起点,
          低频全局项放视觉终点,两侧分组也避免三个图标挤在一起的误触 */}
      <header className="flex items-center justify-between px-4 pb-1 pt-3">
        {(() => {
          // 运行中置灰「新对话 / 历史会话」:二者在运行中都不可用(切换能力后续再做)
          const busy = status !== "idle";
          return (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={onOpenSessions}
                disabled={busy}
                aria-label={t("chat.openSessions")}
                title={busy ? t("chat.busySessionsHint") : undefined}
                className={busy ? "icon-btn opacity-30" : "icon-btn"}
              >
                <HistoryIcon />
              </button>
              <button
                type="button"
                onClick={() => {
                  chat.resetConversation();
                  setInput("");
                  clearAttachments();
                  releaseAllImgUrls();
                }}
                disabled={busy}
                aria-label={t("chat.newChat")}
                title={busy ? t("chat.busyNewChatHint") : undefined}
                className={busy ? "icon-btn opacity-30" : "icon-btn"}
              >
                <PlusIcon />
              </button>
            </div>
          );
        })()}
        <div className="flex gap-1">
          <LanguageMenu />
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={t("chat.openSettings")}
            className="icon-btn"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      {/* 消息列表 + 悬浮层锚点:滚离底部时右下角浮现「回到最新」 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          role="log"
          aria-live="polite"
          aria-atomic="false"
          className="h-full overflow-y-auto px-4 pt-2 pb-8"
        >
          {/* 内容列:面板拖宽后封顶 560px 居中,窄面板不变 */}
          <div className="mx-auto w-full max-w-[560px] space-y-3">
        {(() => {
          // 注入的伪 user 消息(截图附件注记)只属于模型管线,对话流不渲染
          // —— 实况视图本来就不显示它,回放对齐;落盘仍全量(synthetic 行
          // 留在库与 messages 态里,只是不进消息流)
          const visible = messages.filter(
            (m) => m.sessionId === currentSession && !m.synthetic,
          );
          if (visible.length === 0 && status === "idle")
            return (
              <EmptyState
                onPick={(text) => {
                  setInput(text);
                  chatInputRef.current?.focus();
                }}
                showQuote={quoteEnabled}
              />
            );
          // 轨迹插在最后一条 user 消息之后:它是「当前这轮」的过程,
          // 本轮流式答案(assistant 气泡)自然排在轨迹后面;历史回放时 trace 为空不渲染
          const lastUserIdx = visible.reduce(
            (acc, m, i) => (m.role === "user" ? i : acc),
            -1,
          );
          // 重新生成的挂点:本轮答案在 RunZone(settled 收尾气泡)由它自己挂;
          // 无本轮答案时,只有当可见消息的最后一条就是普通 assistant 气泡
          // (历史回放/上一轮归档后)才挂——重答截到末条 user,挂中间气泡会误导。
          // processOnly 纯过程行不是答案,排除
          let lastAssistantIdx = -1;
          if (runSegs.length === 0 && status === "idle") {
            const last = visible[visible.length - 1];
            if (
              last &&
              last.role === "assistant" &&
              !last.error &&
              !last.notice &&
              !last.processOnly
            ) {
              lastAssistantIdx = visible.length - 1;
            }
          }
          // 错误重试挂点:与 lastAssistantIdx 同规则,只有末条就是错误气泡
          // 才挂 —— 重试 = regenerate(截到末条 user 重跑),挂在中间错误上
          // 会让重试范围看起来比实际大
          let lastErrorIdx = -1;
          if (runSegs.length === 0 && status === "idle") {
            const last = visible[visible.length - 1];
            if (last && last.role === "assistant" && last.error) {
              lastErrorIdx = visible.length - 1;
            }
          }
          // 压缩分隔条插在第一条 seq 超过压缩点的记录之前;历史消息按 seq
          // 升序,所以命中第一条之后不再重复插
          let dividerPlaced = false;
          return visible.flatMap((m, i) => {
            const showDivider =
              compaction !== null &&
              !dividerPlaced &&
              (m.seq ?? Number.MAX_SAFE_INTEGER) > compaction.uptoSeq;
            if (showDivider) dividerPlaced = true;
            const divider = showDivider ? [<CompactionDivider key="ctx-div" />] : [];
            const node =
              m.role === "user" ? (
                <UserBubble key={i} text={m.content} images={m.images} />
              ) : m.error ? (
                // 失败轮:过程卡(如有)+ 错误气泡,与实况「过程卡 → 错误」同构
                <div key={i} className="flex flex-col gap-1.5">
                  {m.processItems && m.processItems.length > 0 && (
                    <ReplayProcessCard items={m.processItems} />
                  )}
                  <ErrorBubble
                    text={m.content}
                    onRetry={i === lastErrorIdx ? chat.regenerate : undefined}
                  />
                </div>
              ) : m.notice ? (
                <NoticeBubble key={i} kind={m.noticeKind} />
              ) : m.processItems && m.processItems.length > 0 ? (
                // 历史回放:过程卡(思考/中间文案/工具)+ 收尾气泡 ——
                // 与实况 settled 布局同构;processOnly 载体行(无收尾
                // 记录的 run)只有卡
                <div key={i} className="flex flex-col gap-1.5">
                  <ReplayProcessCard items={m.processItems} />
                  {!m.processOnly && (
                    <AssistantBubble
                      text={m.content}
                      actions={i === lastAssistantIdx ? "copy-regen" : "copy"}
                      onRegenerate={i === lastAssistantIdx ? chat.regenerate : undefined}
                    />
                  )}
                </div>
              ) : (
                <AssistantBubble
                  key={i}
                  text={m.content}
                  actions={i === lastAssistantIdx ? "copy-regen" : "copy"}
                  onRegenerate={i === lastAssistantIdx ? chat.regenerate : undefined}
                />
              );
            // 执行流插在最后一条 user 消息之后:按到达顺序交错渲染;
            // 历史回放时 segs 为空不渲染
            return i === lastUserIdx && runSegs.length > 0
              ? [
                  ...divider,
                  node,
                  <RunZone
                    key="run-zone"
                    segs={runSegs}
                    phase={runPhase}
                    endedAt={runEndedAt}
                    openGroups={openGroups}
                    onToggleGroup={toggleGroup}
                    onRegenerate={chat.regenerate}
                  />,
                ]
              : [...divider, node];
          });
        })()}
        {/* 网络等待等「无过程可看」时的活动指示;思考 ticker 存在时由 ticker 表达,不重复 */}
        {status === "thinking" &&
          !runSegs.some((s) => s.kind === "reasoning" && s.active) && (
            <div className="flex items-center gap-1.5 py-1 pl-1 text-on-surface-variant">
              <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
            </div>
          )}
        {/* 记忆落库轻提示:仅当本轮发生过保存时出现,点击直通记忆管理页 */}
        {memorySaved > 0 && (
          <button
            type="button"
            onClick={onOpenMemory}
            className="memory-hint"
            aria-label={t("chat.memorySavedHint", { n: memorySaved })}
          >
            <ArchiveIcon /> {t("chat.memorySavedLabel", { n: memorySaved })}
          </button>
        )}
          </div>
        </div>
        {(() => {
          // 上翻回看后流式仍在推进/内容很长时,给一个单跳回底的入口
          const hasContent =
            messages.some((m) => m.sessionId === currentSession) ||
            runSegs.length > 0;
          if (atBottom || !hasContent) return null;
          return (
            <button
              type="button"
              onClick={scrollToLatest}
              aria-label={t("chat.jumpLatest")}
              title={t("chat.jumpLatest")}
              className="jump-latest msg-in"
            >
              <ArrowDownIcon />
            </button>
          );
        })()}
      </div>

      {/* 写操作确认卡:后台在执行点击/填写前停下等答复;展示目标页与写入内容 */}
      {confirmReq && (
        <ConfirmCard req={confirmReq} onAnswer={chat.answerConfirm} />
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
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
            onManage={onOpenSkills}
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
                submit();
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
              void addAttachments(Array.from(e.target.files ?? []));
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
                curModelEntry?.reasoningEffort ??
                thinkingDefault ??
                // 类型兜底:showThinking 已蕴含 options 非空,运行时不可达
                (thinkingOptions.includes("off") ? "off" : thinkingOptions[0])
              }
              onPick={setThinkingEffort}
            />
          )}
          {/* 发送/停止是同一个按钮:状态切换不换元素,焦点不掉(键盘用户
              停止后 space 仍是同一颗键)。36px 与 settings-btn 同高 —— M3
              Expressive 的研究实测更大的主动作键命中更快;箭头用 SVG 不用
              「↑」字形,字形光学尺寸随平台字体漂移。图标以 key 触发 msg-in
              轻浮升过渡,状态翻转有 250ms emphasized 的完成感 */}
          <button
            type={status === "idle" ? "submit" : "button"}
            onClick={status === "idle" ? undefined : chat.cancel}
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
    </div>
  );
}
