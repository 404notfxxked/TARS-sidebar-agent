// React 19 演示：useActionState + useOptimistic
import { useActionState, useOptimistic } from 'react'

interface MessageState {
  messages: string[]
}

async function saveMessage(
  prevState: MessageState,
  formData: FormData
): Promise<MessageState> {
  await new Promise((resolve) => setTimeout(resolve, 600))
  const raw = formData.get('message')
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return prevState
  return { messages: [...prevState.messages, text] }
}

export default function MessageForm() {
  const [state, formAction, isPending] = useActionState<MessageState, FormData>(
    saveMessage,
    { messages: [] }
  )
  const [optimisticMessages, addOptimistic] = useOptimistic<string[], string>(
    state.messages,
    (current, next) => [...current, next]
  )

  return (
    <section className="bg-white border border-gray-200 rounded-lg px-4 py-3.5 shadow-sm">
      <h2 className="text-[13px] m-0 mb-2.5 text-gray-500 font-semibold uppercase tracking-wider">
        React 19 · Actions + Optimistic UI
      </h2>
      <ul className="list-none p-0 m-0 mb-2.5 max-h-[140px] overflow-y-auto text-[13px]">
        {optimisticMessages.map((m, i) => (
          <li
            key={i}
            className="py-1 border-b border-dashed border-gray-100 last:border-b-0"
          >
            {m}
          </li>
        ))}
        {isPending && <li className="text-gray-400 italic">提交中…</li>}
      </ul>
      <form
        className="flex gap-1.5"
        action={async (formData: FormData) => {
          const raw = formData.get('message')
          const text = typeof raw === 'string' ? raw.trim() : ''
          if (text) {
            addOptimistic(text)
            formAction(formData)
          }
        }}
      >
        <input
          name="message"
          placeholder="说点什么…"
          autoComplete="off"
          className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-md text-[13px] outline-none focus:border-blue-600"
        />
        <button
          type="submit"
          disabled={isPending}
          className="px-3 py-1.5 bg-blue-600 text-white border-none rounded-md text-[13px] cursor-pointer disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          发送
        </button>
      </form>
    </section>
  )
}
