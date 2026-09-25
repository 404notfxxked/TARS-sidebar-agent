// 图片附件:待发队列(pendingImages)、预览提示、文件选择/粘贴统一入口。
// ⚠️ pendingImagesRef 是准入判定的镜像 ref,与 state 在同一帧提交
// (commitPendingImages):压缩是异步的,两次快速粘贴若按 state 闭包算余量
// 会一起通过门控突破 MAX_ATTACHMENTS。压缩管线纯函数在 chat/images.ts。

import { useEffect, useRef, useState } from "react";
import {
  MAX_ATTACHMENTS,
  compressImage,
  ownsImgUrl,
  type PendingImage,
} from "./images";
import { useT } from "../ui/hooks";

export function useAttachments(visionOk: boolean) {
  const t = useT();
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

  // 提示的延时熄灭计时器:卸载时清理
  useEffect(() => {
    return () => {
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
    };
  }, []);

  /** 清空待发附件(切会话/新对话/发送后):预览 objectURL 一并回收。
   *  已交棒给气泡缓存的(发送出去的图)不在这里撤:气泡的 <img> 是重渲染时
   *  才创建的,此刻撤销会让它加载失败(浏览器对「先撤销、后新建元素」必失败),
   *  那批 URL 的生命周期随之归消息列表 —— 切会话/新对话时由 releaseAllImgUrls
   *  统一回收。
   *  ⚠️ 不在此清 attachHint:发送路径是「flashHint(图片不会发送) → 附件入队清空」,
   *  若这里顺手 setAttachHint(""),resolveContext 不等浏览器往返时两步会落进同一
   *  React 批次 —— 提示被置上又立刻清掉、一帧都不上屏,用户与 e2e 都看不到。
   *  提示自带 3s 计时器,生命周期由它自己管。 */
  const clearAttachments = () => {
    for (const p of pendingImagesRef.current) {
      if (!ownsImgUrl(p.id)) URL.revokeObjectURL(p.url);
    }
    commitPendingImages([]);
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

  return {
    pendingImages,
    attachHint,
    fileInputRef,
    addAttachments,
    removePending,
    clearAttachments,
    flashHint,
  };
}
