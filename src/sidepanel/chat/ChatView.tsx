// 对话视图:经 port 连 SW,ReAct agent 的流式回复渲染。
// 本文件只保留「接线与布局」:port 事件分发、消息列表/输入区渲染、附件入口;
// 执行流状态机在 chat/useRunSegments,过程卡渲染在 chat/trace,
// 气泡与 markdown 在 chat/bubbles,图片管线与缓存在 chat/images。

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  MSG,
  PORT_NAME,
  type AgentEvent,
  type CompactionMark,
  type ImageMeta,
  type SkillInfo,
} from "../../shared/messages";
import { t } from "../../shared/i18n";
import { parseSkillInvocation } from "../../shared/skills";
import { getActiveTabId } from "../../shared/contentTools";
import {
  loadConfig,
  savePrefs,
  type ProviderEntry,
} from "../../shared/configStore";
import { createLogger } from "../../shared/logger";
import {
  MAX_ATTACHMENTS,
  cacheImgUrl,
  compressImage,
  resolveImageData,
  setImageSender,
  type PendingImage,
} from "./images";
import { useRunSegments } from "./useRunSegments";
import { RunZone } from "./trace";
import {
  AssistantBubble,
  CompactionDivider,
  ErrorBubble,
  NoticeBubble,
  UserBubble,
} from "./bubbles";
import ModelPicker from "./ModelPicker";
import SkillMenu from "./SkillMenu";
import { skillReq } from "../clients/skillClient";
import { ArchiveIcon, LogoMark } from "../ui/icons";

// 面板侧只记时间线锚点(port 断开/取消/提交),事件细节以后台日志为准
const log = createLogger({ ctx: "panel" });

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** 所属会话:多会话各自隔离,同屏只渲染 currentSession 的消息 */
  sessionId: string;
  /** 随消息发送的图片(元数据;字节经 GET_IMAGE/IMAGE_DATA 单独取) */
  images?: ImageMeta[];
  /** 后台报错:以 ErrorBubble 呈现,不走 markdown */
  error?: boolean;
  /** 系统运行提示(如步数耗尽):以 NoticeBubble 呈现 */
  notice?: boolean;
  /** 该消息在库里的 seq(仅历史回放有;压缩分隔条据此定位) */
  seq?: number;
}

type AgentStatus = "idle" | "thinking" | "streaming";

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
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  // 当前会话的压缩点(存在 = 更早的历史已压成摘要,列表里渲染分隔条)
  const [compaction, setCompaction] = useState<CompactionMark | null>(null);
  /** 本轮已写入的记忆条数(memory_save 成功且非重复时累计);回复尾轻提示用 */
  const [memorySaved, setMemorySaved] = useState(0);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AgentStatus>("idle");
  /** 待答复的写操作确认请求:非空 = 输入区上方弹确认卡(拒绝/超时由后台兜底) */
  const [confirmReq, setConfirmReq] = useState<
    Extract<AgentEvent, { type: typeof MSG.AGENT_CONFIRM_REQUEST }> | null
  >(null);
  const [currentSession, setCurrentSession] = useState("");
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const sessionRef = useRef("");
  const historyReqRef = useRef("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // 最近一次已加载历史的会话,防重复请求
  const lastLoadedSessionRef = useRef("");

  // ---- 本轮执行流:状态机(hook)+ 归档出口(文本段 → messages) ----
  const run = useRunSegments((texts) => {
    const sid = sessionRef.current;
    setMessages((ms) => [
      ...ms,
      ...texts.map((s) => ({
        role: "assistant" as const,
        content: s,
        sessionId: sid,
      })),
    ]);
  });
  const {
    runSegs,
    runPhase,
    runEndedAt,
    openGroups,
    toggleGroup,
  } = run;

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

  // ---- 图片附件状态 ----
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachHint, setAttachHint] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hintTimer = useRef<number | null>(null);

  /** 打开面板 = 一律新会话(历史去列表找):会话 id 在首次提交时才生成,
   *  没发过消息就不会在后台产生空会话记录 */
  const resolveContext = async (): Promise<{
    tabId: number | undefined;
    sessionId: string;
  }> => {
    const tabId = await getActiveTabId();
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID();
    return { tabId: tabId ?? undefined, sessionId: sessionRef.current };
  };

  const connect = (): chrome.runtime.Port => {
    // 复用已有连接(没断开就不新建)
    if (portRef.current) return portRef.current;

    const port = chrome.runtime.connect({ name: PORT_NAME });
    portRef.current = port;

    // delta 顺序有保证:后台 readSSE 按序处理事件,port 单通道 FIFO 送达。
    // run.* 操作内部走 ref 读最新状态,此监听器只注册一次也安全
    port.onMessage.addListener((evt: AgentEvent) => {
      switch (evt.type) {
        case MSG.AGENT_STARTED:
          sessionRef.current = evt.sessionId;
          setStatus("thinking");
          setMemorySaved(0); // 新一轮,轻提示重新累计
          run.onStarted();
          break;
        case MSG.AGENT_THINKING:
          run.onThinking();
          setStatus("thinking");
          break;
        case MSG.AGENT_REASONING:
          run.onReasoningDelta(evt.delta);
          break;
        case MSG.AGENT_MESSAGE:
          setStatus("streaming");
          run.onMessageDelta(evt.delta);
          break;
        case MSG.AGENT_TOOL_CALL:
          run.onToolCall(evt);
          setStatus("thinking");
          break;
        case MSG.AGENT_CONFIRM_REQUEST:
          setConfirmReq(evt);
          break;
        case MSG.AGENT_TOOL_RESULT:
          run.onToolResult(evt);
          // 记忆落库轻提示:成功的非重复保存累计,回复尾渲染「已写入 N 条」
          if (evt.name === "memory_save" && evt.ok) {
            const r = evt.result as { duplicate?: boolean } | null;
            if (!r?.duplicate) setMemorySaved((n) => n + 1);
          }
          break;
        case MSG.AGENT_DONE:
          run.onSettled();
          setStatus("idle");
          setConfirmReq(null); // 确认卡随 run 收口清掉(超时拒绝后台已兜底)
          // 步数耗尽:模型已按收尾指令交代进展,这里再补一条系统级提示
          if (evt.reason === "max-turns") {
            setMessages((ms) => [
              ...ms,
              {
                role: "assistant",
                content: "",
                sessionId: sessionRef.current,
                notice: true,
              },
            ]);
          }
          break;
        case MSG.AGENT_ERROR:
          // 错误详情由后台日志记录,面板只负责呈现(独立错误样式,不走 markdown)
          run.onSettled();
          setStatus("idle");
          setConfirmReq(null);
          setMessages((ms) => [
            ...ms,
            {
              role: "assistant",
              content: evt.error,
              sessionId: sessionRef.current,
              error: true,
            },
          ]);
          break;
        case MSG.HISTORY:
          // 后端回的历史 → 填入该会话。
          // 仅当该会话在本地面板尚无记录时才填(本地有记录 = 本地更新过/正在用,保留本地);
          // 否则 idempotent,避免覆盖面板里已有的新消息。
          // 发起请求后会话已变(用户切走/抢先提交)则不切换 currentSession。
          if (historyReqRef.current === sessionRef.current) {
            setMessages((ms) => {
              const sid = historyReqRef.current;
              if (ms.some((m) => m.sessionId === sid)) return ms;
              return evt.messages.map((m) => ({ ...m, sessionId: sid }));
            });
            setCompaction(evt.compaction ?? null);
            setCurrentSession(historyReqRef.current);
          }
          break;
        case MSG.IMAGE_DATA:
          // 历史图片字节回填 → 换成 objectURL 交给气泡
          resolveImageData(evt);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      log.warn("chat", "port disconnected");
      portRef.current = null;
      run.onPortDisconnected();
      setStatus("idle");
      setConfirmReq(null);
    });

    return port;
  };

  // 加载某会话历史到面板(去重:同一会话不重复请求)
  const loadSessionHistory = (sessionId: string) => {
    if (sessionId === lastLoadedSessionRef.current) return;
    historyReqRef.current = sessionId;
    lastLoadedSessionRef.current = sessionId;
    connect().postMessage({ type: MSG.LOAD_HISTORY, sessionId });
  };

  // 从历史列表切回某会话:清空本地视图后向后端拉消息。
  // 空串 = 「新对话」入口:回到空白会话态,不发 LOAD_HISTORY,游标一并重置
  const openSession = (sessionId: string) => {
    if (status !== "idle") {
      log.warn("chat", "switch session ignored, run in progress", { sessionId });
      return;
    }
    if (sessionId === sessionRef.current) return; // 已是当前会话
    log.info("chat", "open session", { sessionId });
    setMessages([]);
    setCompaction(null);
    setMemorySaved(0);
    setInput("");
    run.newRound();
    setCurrentSession(sessionId);
    sessionRef.current = sessionId;
    if (sessionId) {
      historyReqRef.current = sessionId;
      loadSessionHistory(sessionId);
    } else {
      historyReqRef.current = "";
      lastLoadedSessionRef.current = "";
    }
  };

  // 历史列表选中 → 打开;消费完立刻回调置空,保证下次选同一会话仍能触发
  // (空串也是有效选择 = 新对话,因此判 null 而非判真值)
  useEffect(() => {
    if (resumeSessionId !== null) {
      openSession(resumeSessionId);
      onResumeDone();
    }
  }, [resumeSessionId]);

  // 当前会话回传给 App,历史列表据此高亮「当前」
  useEffect(() => {
    onActiveSessionChange?.(currentSession);
  }, [currentSession]);

  // 挂载:建 port、读配置。面板打开即新会话,不拉任何历史。
  useEffect(() => {
    connect();
    // 历史图片取字节的发送通道(ChatImage 组件经模块级 requestImgUrl 调用)
    setImageSender((id) => connect().postMessage({ type: MSG.GET_IMAGE, id }));
    // 设置页悬浮关闭后不重挂,配置变更靠 storage 事件同步模型列表
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
    };
    chrome.storage.onChanged.addListener(onStorage);
    loadConfig().then((c) => {
      setProviders(c.providers);
      setModelProvider(c.modelProvider);
      setModelId(c.model);
    });
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      portRef.current?.disconnect();
      portRef.current = null;
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

  const cancel = () => {
    log.info("chat", "cancel clicked", { sessionId: sessionRef.current });
    if (!sessionRef.current) return;
    connect().postMessage({
      type: MSG.CANCEL_RUN,
      sessionId: sessionRef.current,
    });
  };

  // 确认卡答复:把用户的决定带回后台,请求随即出列(等待超时由后台兜底拒绝)
  const answerConfirm = (approved: boolean) => {
    if (!confirmReq) return;
    log.info("chat", "confirm answered", { approved, name: confirmReq.name });
    connect().postMessage({
      type: MSG.CONFIRM_RESPONSE,
      requestId: confirmReq.requestId,
      approved,
    });
    setConfirmReq(null);
  };

  // 面板可见性上报:任务完成通知以「面板是否不可见」为是否打扰的判据。
  // 走 ref 读端口(重连后仍指向最新),监听只注册一次
  useEffect(() => {
    const report = () => {
      try {
        portRef.current?.postMessage({
          type: MSG.PANEL_VISIBILITY,
          hidden: document.visibilityState === "hidden",
        });
      } catch {
        /* 端口已断开,无需上报 */
      }
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, []);

  // 开始新对话:只清本地视图。旧会话原样留在历史列表(多会话语义,
  // 不再通知后台删除);下次提交才会生成新的会话 id
  const resetConversation = () => {
    if (status !== "idle") return; // 运行中不允许打断
    log.debug("chat", "new conversation", { old: sessionRef.current });
    setMessages([]);
    setCompaction(null);
    setMemorySaved(0);
    setInput("");
    run.newRound(); // 对话清空,本轮执行流也不保留
    setCurrentSession("");
    // 重置所有会话游标,保证下一次加载历史 / 提交都从空会话开始
    sessionRef.current = "";
    historyReqRef.current = "";
    lastLoadedSessionRef.current = "";
  };

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
  const enabledSkills = useMemo(
    () => (skillList ?? []).filter((s) => s.enabled),
    [skillList],
  );
  const skillMatches = useMemo(() => {
    const q = slashQuery.toLowerCase();
    if (!q) return enabledSkills;
    return enabledSkills.filter(
      (s) => s.name.includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [enabledSkills, slashQuery]);
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
  useLayoutEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto"; // 先收回再按内容撑开,才能正确收缩
    const h = Math.min(el.scrollHeight, 116);
    el.style.height = `${h}px`;
    // 未到上限不给滚动条,避免 height 追赶 scrollHeight 一帧内出现的幽灵滚动条
    el.style.overflowY = el.scrollHeight > 116 ? "auto" : "hidden";
  }, [input, chatInputRef]);

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
    const room = MAX_ATTACHMENTS - pendingImages.length;
    if (room <= 0) {
      flashHint(t("chat.imageLimit", { max: MAX_ATTACHMENTS }));
      return;
    }
    if (images.length > room) flashHint(t("chat.imageRoom", { room }));
    const added: PendingImage[] = [];
    for (const file of images.slice(0, room)) {
      try {
        added.push(await compressImage(file));
      } catch {
        flashHint(t("chat.imageDecodeFailed", { name: file.name || t("chat.clipboard") }));
      }
    }
    if (added.length > 0) setPendingImages((prev) => [...prev, ...added]);
  };

  const removePending = (id: string) => {
    setPendingImages((prev) => {
      const hit = prev.find((p) => p.id === id);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((p) => p.id !== id);
    });
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
    const { tabId, sessionId } = await resolveContext();
    sessionRef.current = sessionId;
    setCurrentSession(sessionId);
    log.info("chat", "submit", {
      text,
      sessionId,
      tabId,
      images: pendingImages.length,
    });
    // 先归档上一轮文本段(保证它排在本条 user 消息之前),再清空执行流开新一轮
    run.archiveTexts();
    // 本地回显:预览 url 直接转入气泡缓存,渲染无需再向后台取字节
    const metas = pendingImages.map(({ id, mime, w, h }) => ({ id, mime, w, h }));
    for (const p of pendingImages) cacheImgUrl(p.id, p.url);
    setMessages((ms) => [
      ...ms,
      {
        role: "user",
        content: text,
        sessionId,
        ...(metas.length ? { images: metas } : {}),
      },
    ]);
    setInput("");
    const uploads = pendingImages.map(({ mime, base64, w, h }) => ({
      mime,
      base64,
      w,
      h,
    }));
    setPendingImages([]);
    run.newRound(); // AGENT_STARTED 会再兜一次
    connect().postMessage({
      type: MSG.USER_MESSAGE,
      payload: {
        text,
        sessionId,
        tabId,
        ...(uploads.length ? { images: uploads } : {}),
      },
    });
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
                onClick={resetConversation}
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
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t("chat.openSettings")}
          className="icon-btn"
        >
          <SettingsIcon />
        </button>
      </header>

      {/* 消息列表 + 悬浮层锚点:滚离底部时右下角浮现「回到最新」 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          className="h-full space-y-3 overflow-y-auto px-4 pt-2 pb-8"
        >
        {(() => {
          const visible = messages.filter(
            (m) => m.sessionId === currentSession,
          );
          if (visible.length === 0 && status === "idle")
            return (
              <EmptyState
                onPick={(text) => {
                  setInput(text);
                  chatInputRef.current?.focus();
                }}
              />
            );
          // 轨迹插在最后一条 user 消息之后:它是「当前这轮」的过程,
          // 本轮流式答案(assistant 气泡)自然排在轨迹后面;历史回放时 trace 为空不渲染
          const lastUserIdx = visible.reduce(
            (acc, m, i) => (m.role === "user" ? i : acc),
            -1,
          );
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
                <ErrorBubble key={i} text={m.content} />
              ) : m.notice ? (
                <NoticeBubble key={i} />
              ) : (
                <AssistantBubble key={i} text={m.content} />
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
        {/* 回合收尾标记(∎ tombstone):静止且有内容时才出现——流式中的活动
            信号由 ticker/光标承担,空态有招呼语,都不需要它。配合底部大
            留白给答案一个明确的「全文完」呼吸点,而非贴着输入条戛然而止 */}
        {status === "idle" &&
          messages.some((m) => m.sessionId === currentSession) && (
            <div className="msg-in flex justify-center pt-1" aria-hidden="true">
              <EndMark />
            </div>
          )}
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
      {confirmReq && <ConfirmCard req={confirmReq} onAnswer={answerConfirm} />}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="relative mx-3 mb-3 rounded-xl bg-surface-container-high transition-colors duration-200 focus-within:bg-surface-container-highest"
      >
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3.5 pt-2">
            {pendingImages.map((p) => (
              <div key={p.id} className="group relative">
                <img
                  src={p.url}
                  alt={t("chat.pendingImageAlt", { w: p.w, h: p.h })}
                  className="h-14 w-14 rounded-lg object-cover"
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
          <p className="px-3.5 pt-1.5 text-[11.5px] text-on-surface-variant">
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
          {status === "idle" ? (
            <button
              type="submit"
              disabled={!input.trim() && pendingImages.length === 0}
              aria-label={t("chat.send")}
              className="icon-btn-filled ml-auto h-8 w-8 text-[14px] leading-none"
            >
              ↑
            </button>
          ) : (
            <button
              type="button"
              onClick={cancel}
              aria-label={t("chat.stop")}
              className="icon-btn-filled error ml-auto h-8 w-8"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
              >
                <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" />
              </svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.3 1.6" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <circle cx="6" cy="4" r="1.7" fill="currentColor" stroke="none" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <circle cx="10.5" cy="8" r="1.7" fill="currentColor" stroke="none" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
      <circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="5.8" cy="6.3" r="1.2" />
      <path d="m2.5 11.5 3-3 2.5 2.5 2-2 3.5 3.5" />
    </svg>
  );
}

// ---- 空态文案池 ----
// 键位表是静态字面量(check-i18n 扫描的是源码里全部键形字面量,变量持键
// 合法、模板拼键才 FAIL);文案渲染期经 t() 现取,换语言即随渲染刷新。
// 每次空态挂载随机抽一条招呼语 + 3 枚 chips,重开面板即换一批。
const GREETINGS = [
  { title: "chat.greetTitle0", sub: "chat.greetSub0" },
  { title: "chat.greetTitle1", sub: "chat.greetSub1" },
  { title: "chat.greetTitle2", sub: "chat.greetSub2" },
  { title: "chat.greetTitle3", sub: "chat.greetSub3" },
  { title: "chat.greetTitle4", sub: "chat.greetSub4" },
  { title: "chat.greetTitle5", sub: "chat.greetSub5" },
  { title: "chat.greetTitle6", sub: "chat.greetSub6" },
  { title: "chat.greetTitle7", sub: "chat.greetSub7" },
  { title: "chat.greetTitle8", sub: "chat.greetSub8" },
  { title: "chat.greetTitle9", sub: "chat.greetSub9" },
] as const;

const SUGGESTIONS = [
  "chat.suggestRead",
  "chat.suggestDigest",
  "chat.suggestSearch",
  "chat.suggestForm",
  "chat.suggestTable",
  "chat.suggestExplore",
  "chat.suggestTranslate",
  "chat.suggestSources",
  "chat.suggestRemember",
  "chat.suggestCompare",
] as const;

/** Fisher-Yates 洗牌(纯函数) */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 空态:品牌标 + 随机招呼语 + 快捷提问 chips(点击即回填输入框并聚焦)。
 *  chips 从 10 条池里抽 3,「换一批」原地重抽,不必重开面板 */
function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  // 挂载时定一次,重渲不重抽(否则流式期间招呼语会跳变)
  const [greetIdx] = useState(() =>
    Math.floor(Math.random() * GREETINGS.length),
  );
  const [chipKeys, setChipKeys] = useState(() =>
    shuffle(SUGGESTIONS).slice(0, 3),
  );
  const greet = GREETINGS[greetIdx];
  return (
    <div className="flex flex-col items-center px-6 pb-10 pt-16 text-center">
      <LogoMark />
      <p className="mt-4 text-[15px] font-medium text-on-surface">
        {t(greet.title)}
      </p>
      <p className="mt-1.5 max-w-[240px] text-[12.5px] leading-relaxed text-on-surface-variant">
        {t(greet.sub)}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {chipKeys.map((key) => {
          const label = t(key);
          return (
            <button
              key={key}
              type="button"
              className="empty-chip"
              onClick={() => onPick(label)}
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          className="icon-btn"
          aria-label={t("chat.suggestShuffle")}
          title={t("chat.suggestShuffle")}
          onClick={() => setChipKeys(shuffle(SUGGESTIONS).slice(0, 3))}
        >
          <ShuffleIcon />
        </button>
      </div>
    </div>
  );
}

/** 回合收尾记号:细线 + 圆点(「——·——」的排版变体)。纯装饰(aria-hidden) */
function EndMark() {
  return (
    <span className="end-mark" aria-hidden="true">
      <span className="end-mark-dot" />
    </span>
  );
}

/** 回到最新:实心下箭头(滚回列表底部) */
function ArrowDownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.8v10.4" />
      <path d="m3.6 9 4.4 4.2L12.4 9" />
    </svg>
  );
}

/** 换一批:双箭头循环(rotate/refresh 语义) */function ShuffleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.5 2.5v3h-3" />
      <path d="M3.2 6.2a5 5 0 0 1 8.6-0.4l0.7 0.9" />
      <path d="M3.5 13.5v-3h3" />
      <path d="M12.8 9.8a5 5 0 0 1-8.6 0.4l-0.7-0.9" />
    </svg>
  );
}

/** 写操作确认卡:工具名 + 目标页 + 参数摘要(写入内容/定位/是否回车提交),
 *  给用户足够信息做「允许 / 拒绝」决定;视觉沿用 combo-pop 浮层语言 */
function ConfirmCard({
  req,
  onAnswer,
}: {
  req: Extract<AgentEvent, { type: typeof MSG.AGENT_CONFIRM_REQUEST }>;
  onAnswer: (approved: boolean) => void;
}) {
  const args = (req.args ?? {}) as {
    selector?: string;
    text?: string;
    pressEnterAfter?: boolean;
  };
  const host = (() => {
    try {
      return req.tabUrl ? new URL(req.tabUrl).hostname : "";
    } catch {
      return "";
    }
  })();
  const targetLabel = req.tabTitle
    ? host
      ? `${req.tabTitle}（${host}）`
      : req.tabTitle
    : host;
  const isFill = req.name === "fill_input";
  const fillText =
    isFill && typeof args.text === "string" ? args.text.slice(0, 80) : "";
  return (
    <div
      role="alertdialog"
      aria-label={t("chat.confirmTitle")}
      className="mx-3 mb-2 rounded-xl bg-surface-container-high p-3 shadow-2"
    >
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-on-surface">
        <ConfirmIcon />
        {req.displayName || req.name} · {t("chat.confirmTitle")}
      </p>
      {targetLabel && (
        <p className="mt-1 truncate text-[11.5px] text-on-surface-variant">
          {t("chat.confirmTarget", { title: targetLabel })}
        </p>
      )}
      {fillText && (
        <p className="mt-1 break-all text-[11.5px] text-on-surface-variant">
          {t("chat.confirmFillText", { text: fillText })}
          {args.text && args.text.length > 80 ? "…" : ""}
        </p>
      )}
      {isFill && args.pressEnterAfter && (
        <p className="mt-1 text-[11.5px] text-error">
          {t("chat.confirmSubmitHint")}
        </p>
      )}
      {typeof args.selector === "string" && args.selector && (
        <p className="mt-1 truncate font-mono text-[11px] text-on-surface-variant">
          {t("chat.confirmSelectorLabel", { selector: args.selector })}
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onAnswer(false)}
          aria-label={t("chat.confirmDeny")}
          className="btn-text"
        >
          {t("chat.confirmDeny")}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(true)}
          aria-label={t("chat.confirmAllow")}
          className="icon-btn-filled ml-2 h-8 px-3 text-[12px] font-medium leading-none"
        >
          {t("chat.confirmAllow")}
        </button>
      </div>
    </div>
  );
}

function ConfirmIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M8 1.8 13.5 4v4.2c0 3.1-2.3 5.3-5.5 6.2-3.2-.9-5.5-3.1-5.5-6.2V4L8 1.8Z" />
      <path d="m5.6 8 1.7 1.7 3.1-3.3" strokeLinecap="round" />
    </svg>
  );
}
