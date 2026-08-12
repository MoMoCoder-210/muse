import { useEffect, useRef, useState } from "react";

type DemoMessage = { role: "user" | "assistant"; content: string };
const WELCOME = `Demo 对话助手（尚未接入真实 Agent session）

• 查询作品、分集、素材状态
• 生成素材图片 / 镜头视频
• AI 超分素材或镜头
• 管理镜头与导出设置

请选择作品后输入你的需求。`;

type Props = { open: boolean; onClose: () => void };

export function AgentChatDrawer({ open, onClose }: Props) {
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  const handleSend = () => {
    const text = input.trim(); if (!text) return;
    setMessages((current) => [...current, { role: "user", content: text }, { role: "assistant", content: `收到：“${text}”\n\n这是 Demo 阶段，真实调用将在后续接入。` }]);
    setInput("");
  };
  const handleKeyDown = (event: React.KeyboardEvent) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); handleSend(); } };
  return <div className={`agent-drawer${open ? " agent-drawer--open" : ""}`}><div className="agent-drawer__inner"><div className="agent-drawer__header"><span>Demo 对话助手（尚未接入真实 Agent session）</span><button className="agent-drawer__close" onClick={onClose} type="button" title="关闭对话" aria-label="关闭对话">×</button></div><div className="agent-drawer__messages">{messages.length === 0 && <div className="agent-drawer__welcome">{WELCOME.split("\n").map((line, index) => <p key={index}>{line}</p>)}</div>}{messages.map((message, index) => <div key={index} className={`agent-bubble${message.role === "user" ? " agent-bubble--user" : ""}`}><p>{message.content}</p></div>)}<div ref={chatEndRef} /></div><div className="agent-drawer__input"><div className="agent-drawer__input-box"><textarea className="agent-drawer__textarea" rows={2} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} placeholder="输入指令… (Enter 发送，Shift+Enter 换行)" /><div className="agent-drawer__input-bar"><span className="agent-drawer__token-info">0/128K</span><button className="agent-drawer__send" onClick={handleSend} disabled={!input.trim()} type="button" aria-label="发送">↑</button></div></div></div></div></div>;
}
