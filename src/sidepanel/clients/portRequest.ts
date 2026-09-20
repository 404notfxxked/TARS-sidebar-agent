// 一次性 port RPC:connect → 发一条请求 → 等首条匹配的回包即断开。
// 常驻 port(SessionsView 那种 ref 持有、复用连接的形态)不走这里,勿并。

import { PORT_NAME } from "../../shared/messages";

/** 发一条请求,等指定类型(可选附加匹配,如按 id 配对)的回包原样返回;
 *  port 断开(后台无应答/已回收)reject "port closed"。
 *  回包形状由调用方以泛型声明(只窄化类型,不做运行时校验;此处只认 type 字段) */
export function portReq<T extends object = Record<string, unknown>>(
  msg: Record<string, unknown>,
  replyType: string,
  match?: (evt: T) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((raw: unknown) => {
      const evt = raw as T & { type?: string };
      if (evt.type === replyType && (!match || match(evt))) {
        resolve(evt);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => reject(new Error("port closed")));
    port.postMessage(msg);
  });
}
