import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

export const Route = createFileRoute('/')({
  component: ChatPage,
});

function ChatPage() {
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    const userMsg = { role: 'user', content: input };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMsg] }),
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let assistant = '';
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          assistant += decoder.decode(value);
        }
      }
      setMessages((m) => [...m, { role: 'assistant', content: assistant }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 640,
        margin: '40px auto',
        padding: '0 16px',
      }}
    >
      <h1>Chat — TanStack Start + @pisama/sdk</h1>
      <p style={{ color: '#666' }}>
        This is the reference integration for @pisama/sdk on TanStack Start. See{' '}
        <code>src/routes/api/chat.ts</code> for the observe() wrap.
      </p>
      <div style={{ minHeight: 200, marginTop: 24 }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              padding: 12,
              margin: '8px 0',
              borderRadius: 8,
              background: m.role === 'user' ? '#e0f0ff' : '#f5f5f5',
            }}
          >
            <strong>{m.role}</strong>: {m.content}
          </div>
        ))}
      </div>
      <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say something..."
          disabled={busy}
          style={{ flex: 1, padding: 10, fontSize: 16, borderRadius: 8 }}
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>
    </main>
  );
}
