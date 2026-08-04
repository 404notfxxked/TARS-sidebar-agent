// React 19 演示：use() 钩子 + Suspense 解包 Promise
import { use, Suspense, useEffect, useState } from "react";

// 模拟"接口"：返回一个 Promise
const greetingPromise = new Promise<string>((resolve) => {
  setTimeout(() => resolve("Hello World! · 来自 use() 钩子"), 800);
});

function Greeting() {
  const message = use(greetingPromise);
  return <p className="m-0 text-base text-blue-600">{message}</p>;
}

export default function GreetingPanel() {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const cb = (event: MediaQueryListEvent) => {
      console.log("theme changed", event.matches);
      setDarkMode(event.matches);
    };
    mq.addEventListener("change", cb);

    return () => {
      mq.removeEventListener("change", cb);
    };
  }, []);

  return (
    <section className="bg-white border border-gray-200 rounded-lg px-4 py-3.5 shadow-sm">
      <h2 className="text-[13px] m-0 mb-2.5 text-gray-500 font-semibold uppercase tracking-wider">
        React 19 · use() + Suspense
      </h2>
      <div>当前主题: {darkMode ? "深色" : "浅色"}</div>
      <Suspense
        fallback={<p className="m-0 text-gray-400 text-[13px]">Loading…</p>}
      >
        <Greeting />
      </Suspense>
    </section>
  );
}
