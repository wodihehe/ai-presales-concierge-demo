import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronRight, Clock3, FileCheck2, Headphones, Layers3, Leaf, MessageCircle, Paperclip, Plus, Send, ShieldCheck, Sparkles, Workflow, X } from 'lucide-react';
import { api, feedbackLabels, formatDate, formatMoney, knowledgeLabels, post } from './api';
import { Attachment, Brand, Button, Field, Loading, Modal, Notice } from './shared';
import {getLocale} from '../../shared/browser-locale.js';

const services = [
  { icon: Sparkles, name: 'AI Agent 定制', detail: '让重复工作交给 AI', prompt: '我想定制一个 AI Agent，帮团队处理重复工作。' },
  { icon: Workflow, name: '工作流搭建', detail: '把业务环节连接起来', prompt: '我想搭建自动化工作流，减少日常操作。' },
  { icon: Layers3, name: '本地大模型部署', detail: '让 AI 服务于自有环境', prompt: '我想了解本地大模型部署，数据保留在自己的环境中。' },
  { icon: Leaf, name: '企业级 AI 落地', detail: '从业务场景到实际应用', prompt: '我们想在公司落地 AI Agent，需要梳理适合的业务场景。' },
];

export function Chat() {
  const [config, setConfig] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    const compose = event => setText(event.detail);
    window.addEventListener('demo-compose', compose);
    return () => window.removeEventListener('demo-compose', compose);
  }, []);
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newError, setNewError] = useState('');
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [success, setSuccess] = useState('');
  const fileInput = useRef(null);
  const composer = useRef(null);
  const thread = useRef(null);
  const request = useRef(null);
  const operation = useRef(null);
  const activeConversation = useRef(null);
  const newDialog = useRef(false);
  const focusNewConversation = useRef(null);
  const embedded = new URLSearchParams(location.search).get('embed') === '1';

  async function load() {
    setLoading(true); setError('');
    try {
      const [publicData, session] = await Promise.all([api('/api/public/config'), api('/api/session')]);
      activeConversation.current = session.conversation.id;
      setConfig(publicData); setConversation(session.conversation);
      document.title = `${publicData.companyName} · 项目咨询`;
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!thread.current || busy === 'new' || focusNewConversation.current) return;
    const hasMessages = conversation?.messages?.some(message => message.role === 'user');
    thread.current.scrollTo({ top: hasMessages ? thread.current.scrollHeight : 0, behavior: hasMessages && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
  }, [conversation?.id, conversation?.messages?.length, busy]);
  useEffect(() => {
    if (newOpen || focusNewConversation.current !== conversation?.id) return;
    // Wait for the confirmation modal's focus-restoration cleanup to finish.
    const frame = requestAnimationFrame(() => {
      if (activeConversation.current !== focusNewConversation.current) return;
      composer.current?.focus({ preventScroll: true });
      thread.current?.scrollTo({ top: 0, behavior: 'instant' });
      focusNewConversation.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [conversation?.id, newOpen]);
  useEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = 'auto';
    composer.current.style.height = `${Math.min(composer.current.scrollHeight, 128)}px`;
  }, [text]);

  function beginOperation(name) {
    if (!conversation || operation.current || activeConversation.current !== conversation.id || (newDialog.current && name !== 'new')) return null;
    const token = { name, conversationId: conversation.id };
    operation.current = token;
    setBusy(name);
    return token;
  }
  function endOperation(token) {
    if (operation.current !== token) return;
    operation.current = null;
    setBusy('');
  }
  async function mutate(action, body, name = action) {
    const token = beginOperation(name);
    if (!token) return null;
    setError('');
    try {
      const data = await post(`/api/conversations/${token.conversationId}/${action}`, body);
      if (activeConversation.current !== token.conversationId) return null;
      if (data.conversation) setConversation(data.conversation);
      return data;
    }
    catch (err) { setError(err.message); return null; }
    finally { endOperation(token); }
  }
  async function send(event) {
    event?.preventDefault();
    const content = text.trim();
    if (!conversation || (!content && !attachments.length) || operation.current || newDialog.current) return;
    const ids = attachments.map(a => a.id);
    const signature = JSON.stringify([conversation.id, content, ids, conversation.summaryVersion]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    const data = await mutate('messages', { content, attachmentIds: ids, requestId: request.current.id, summaryVersion: conversation.summaryVersion }, 'send');
    if (data) { setText(''); setAttachments([]); request.current = null; composer.current?.focus(); }
  }
  async function upload(event) {
    const files = [...(event.target.files || [])]; event.target.value = '';
    if (!files.length || !conversation || operation.current || newDialog.current) return;
    if (files.length + attachments.length > 3) return setError('每条消息最多添加 3 个附件，请分次发送。');
    if (files.some(file => file.size > (config?.maxFileBytes || 5000000))) return setError('单个文件不能超过 5MB，请压缩文件后再试。');
    const token = beginOperation('upload');
    if (!token) return;
    setUploading(true); setError('');
    try {
      for (const file of files) {
        try {
          const body = new FormData(); body.append('file', file);
          const data = await post(`/api/conversations/${token.conversationId}/attachments`, body);
          if (activeConversation.current === token.conversationId) setAttachments(old => [...old, data.attachment]);
        } catch (err) { setError(`${file.name}：${err.message}`); }
      }
    } finally { setUploading(false); endOperation(token); }
  }
  async function handoff() {
    if (!conversation || newDialog.current || operation.current?.name === 'new') return;
    setHandoffOpen(true);
    if (!conversation.handoff && !operation.current) await mutate('handoff', {});
  }
  function openNewConversation() {
    if (!conversation || loading || operation.current || handoffOpen || summaryOpen || newDialog.current) return;
    newDialog.current = true;
    setNewError('');
    setNewOpen(true);
  }
  function closeNewConversation() {
    if (operation.current) return;
    newDialog.current = false;
    setNewOpen(false);
  }
  async function newConversation() {
    if (!newDialog.current) return;
    const token = beginOperation('new');
    if (!token) return;
    setNewError('');
    try {
      const data = await post('/api/conversations');
      activeConversation.current = data.conversation.id;
      focusNewConversation.current = data.conversation.id;
      setConversation(data.conversation);
      setText(''); setAttachments([]); setSuccess(''); setError('');
      setHandoffOpen(false); setSummaryOpen(false); setNewOpen(false);
      newDialog.current = false;
      request.current = null;
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) { setNewError(`新对话暂时没有建好：${err.message} 当前对话、草稿和附件选择都已保留。`); }
    finally { endOperation(token); }
  }
  const messages = conversation?.messages || [];
  const hasUserMessages = messages.some(m => m.role === 'user');
  const profile = conversation?.profile || {};
  const projectKnown = !!(profile.project || profile.problem || profile.scenario);
  const canConfirm = conversation?.summaryReady && !conversation?.summaryConfirmed;
  const stage = conversation?.contactSubmitted ? 3 : conversation?.summaryConfirmed ? 2 : projectKnown ? 1 : 0;

  return <main className={`chat-page ${embedded ? 'embedded' : ''}`}>
    {!embedded && <header className="site-header"><Brand name={config?.companyName} /><div className="header-actions"><span className="availability"><i />全天接待</span><button className="text-button" onClick={handoff} disabled={!conversation || busy === 'new'}><Headphones size={17} />联系人工</button></div></header>}
    <div className="consultation-layout">
      {!embedded && <aside className="intro-panel">
        <div className="intro-top"><span className="eyebrow"><span /> 从一个想法开始</span><h1>你的业务，<br />AI 可以做得<br /><em>更多一点。</em></h1><p className="intro-description">不用先写好一份需求书。<br />聊聊你想解决的问题，<br />我们一起把想法梳理清楚。</p></div>
        <div className="journey" aria-label="咨询进度">{['聊聊项目想法', '确认需求范围', '了解参考方案', '与顾问继续沟通'].map((label, i) => <div key={label} className={`journey-step ${stage >= i ? 'active' : ''}`}><span>{stage > i ? <Check size={13} /> : `0${i + 1}`}</span><p>{label}</p>{stage === i && <i />}</div>)}</div>
        <div className="intro-bottom"><ShieldCheck size={18} /><p>咨询无需登录<br /><span>记录与附件保留 30 天</span></p></div>
      </aside>}
      <section className="chat-card" aria-label="项目咨询聊天">
        <header className="chat-header"><div className="advisor-identity"><span className="advisor-avatar"><Sparkles size={22} /></span><div><h2>{config?.companyName || 'AI 业务顾问'}</h2><p>{config?.modelConfigured ? '先聊需求，再一起找到方向' : '可以留言，我们会协助评估'}</p></div></div><div className="chat-header-actions"><button className="icon-button mobile-human" aria-label="联系人工" onClick={handoff} disabled={!conversation || busy === 'new'}><Headphones size={19} /><span>人工</span></button><button className="new-conversation" onClick={openNewConversation} disabled={!conversation || loading || !!busy || uploading || handoffOpen || summaryOpen || newOpen}><Plus size={16} /><span>新建对话</span></button></div></header>
        <div className="chat-thread" ref={thread}>
          {loading ? <Loading label="正在准备你的咨询空间…" /> : !conversation ? <div className="load-failure"><Notice tone="danger">{error}</Notice><Button onClick={load}>重新连接</Button></div> : <>
            <div className="thread-date"><span>{hasUserMessages ? '你的项目咨询' : '你好，很高兴认识你'}</span></div>
            {!hasUserMessages && <div className="welcome-block"><div className="welcome-flower"><Sparkles size={26} strokeWidth={1.5} /></div><h3>想把 AI 用在哪件事上？</h3><p>从一个想法、一段描述，<br className="small-only" />或者一份现有资料开始，都可以。</p>{config?.companyDescription && <p className="company-intro">{config.companyDescription.slice(0, 180)}{config.companyDescription.length > 180 ? '…' : ''}</p>}<div className="service-options">{services.map(({ icon: Icon, name, detail, prompt }) => <button key={name} onClick={() => { setText(prompt); composer.current?.focus(); }}><Icon size={20} strokeWidth={1.6} /><span><strong>{name}</strong><small>{detail}</small></span><ArrowUp size={15} /></button>)}</div></div>}
            <div className="messages" aria-live="polite" aria-relevant="additions">{messages.map(message => <Message key={message.id} message={message} />)}</div>
            {!config?.modelConfigured && <div className="inline-service-note"><Clock3 size={16} /><span>当前为离线流程演示。逐项补充需求即可体验；自由语义理解和图片理解需要配置真实模型。</span></div>}
            {hasUserMessages && projectKnown && <div className="summary-preview"><div><FileCheck2 size={18} /><strong>{conversation.summaryConfirmed ? '已确认的需求' : '正在梳理的需求'}</strong></div><p>{profile.project || profile.problem || profile.scenario}</p><button className="text-button" onClick={() => setSummaryOpen(true)}>查看需求清单<ChevronRight size={16} /></button></div>}
            {canConfirm && <div className="inline-action"><p>需求清单已经准备好，确认后再评估参考方案。</p><Button variant="secondary" loading={busy === 'confirm'} disabled={!!busy} onClick={() => mutate('confirm', { version: conversation.summaryVersion })}><Check size={16} />需求基本符合</Button></div>}
            {conversation.quote && <QuoteCard conversation={conversation} busy={busy} onFeedback={feedback => mutate('feedback', { feedback, version: conversation.quote.version })} />}
            {conversation.summaryConfirmed && !conversation.quote && <div className="assessment-note"><span className="status-pill neutral">{knowledgeLabels[conversation.knowledgeStatus] || '待人工评估'}</span><p>我们会结合实际需求评估方案和费用，当前没有可提供的参考价格。</p></div>}
            {conversation.knowledgeStatus === 'no_match' && config?.qrUrl && <div className="direct-qr"><img src={config.qrUrl} alt="新类型项目人工顾问企业微信二维码" /><div><strong>这类项目，让顾问来细聊</strong><p>扫码添加企业微信，继续评估你的想法；也可以留下联系方式。</p><button className="text-button" onClick={handoff}>留下联系方式<ArrowRight size={15} /></button></div></div>}{(conversation.handoff || conversation.summaryConfirmed || conversation.contactSubmitted) && <div className="handoff-inline"><div><Headphones size={20} /><span><strong>{conversation.contactSubmitted ? '你的项目信息已登记' : '让顾问接着聊聊'}</strong><small>{conversation.contactSubmitted ? '也可以扫码添加企业微信，继续沟通。' : '留下联系方式，或直接扫码联系。'}</small></span></div><Button variant="secondary" onClick={handoff}>{conversation.contactSubmitted ? '查看交接' : '继续对接'}<ArrowRight size={16} /></Button></div>}
            {success && <Notice tone="success" onClose={() => setSuccess('')}>{success}</Notice>}
            {busy === 'send' && <div className="thinking" role="status"><span className="small-avatar"><Sparkles size={15} /></span><div><i /><i /><i /></div><span>正在整理你的想法…</span></div>}
          </>}
        </div>
        <div className="composer-area">{error && conversation && <Notice tone="danger" onClose={() => setError('')}>{error}</Notice>}{attachments.length > 0 && <div className="pending-attachments">{attachments.map(attachment => <Attachment key={attachment.id} attachment={attachment} onRemove={() => setAttachments(old => old.filter(a => a.id !== attachment.id))} />)}</div>}<form className="composer" onSubmit={send}><textarea ref={composer} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder="聊聊你的项目想法，或者发一份资料…" aria-label="项目需求消息" rows={2} maxLength={4000} disabled={!conversation || busy === 'new'} /><div className="composer-toolbar"><div className="composer-tools"><input hidden ref={fileInput} type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.doc,.docx,.xls,.xlsx" onChange={upload} /><button type="button" className="icon-button" title="添加附件，每个不超过 5MB" aria-label="添加附件" onClick={() => fileInput.current?.click()} disabled={!conversation || uploading || !!busy || attachments.length >= 3}><Paperclip size={20} /></button><span>{uploading ? '正在读取材料…' : '图片 / 文档 · 每个 ≤ 5MB'}</span></div><button type="submit" className="send-button" aria-label="发送消息" disabled={!conversation || !!busy || uploading || (!text.trim() && !attachments.length)}>{busy === 'send' ? <span className="send-spinner" /> : <ArrowUp size={20} />}</button></div></form><div className="composer-foot"><span>AI 协助梳理需求，方案与报价最终由人工确认</span><span className="keyboard-hint">Enter 发送</span></div></div>
      </section>
    </div>
    {!embedded && <footer className="site-footer"><span>好的方案，始于一次充分的沟通。</span><span>30 天数据保留 · 联系信息仅用于项目跟进</span></footer>}
    {handoffOpen && <HandoffModal key={conversation.id} config={config} conversation={conversation} requestBusy={!!busy} beginOperation={beginOperation} endOperation={endOperation} onClose={() => setHandoffOpen(false)} onSaved={(data) => { if (data.conversation?.id !== activeConversation.current) return; setConversation(data.conversation); setSuccess(data.message || '项目信息已登记。'); }} />}
    {newOpen && <Modal title="开始一段新对话？" subtitle="新对话会从空白需求开始；当前咨询和已上传文件仍按原来的 30 天期限保存。" onClose={closeNewConversation}><Notice tone="danger">{newError}</Notice><p className="modal-copy">{text || attachments.length ? '新建成功后，尚未发送的文字和附件选择会清空。取消或新建失败都会保留。' : '如果只是补充当前项目，可以继续当前对话；新项目就从这里重新聊起吧。'}</p><div className="modal-actions"><Button variant="secondary" onClick={closeNewConversation} disabled={!!busy}>继续当前对话</Button><Button loading={busy === 'new'} disabled={!!busy || uploading} onClick={newConversation}>确认新建</Button></div></Modal>}
    {summaryOpen && <Modal title="一起确认需求清单" subtitle={conversation.summaryConfirmed ? '已确认；后续功能变更需要重新评估。' : '这里记录目前已了解的内容，未明确的部分会继续补充。'} onClose={() => setSummaryOpen(false)}><Notice tone="danger">{error}</Notice><Profile profile={profile} /><p className="muted small">需要修改时，回到聊天告诉我们即可。</p><div className="modal-actions"><Button variant="secondary" onClick={() => { setSummaryOpen(false); composer.current?.focus(); }}>返回补充</Button>{canConfirm && <Button loading={busy === 'confirm'} disabled={!!busy} onClick={async () => { const result = await mutate('confirm', { version: conversation.summaryVersion }); if (result) setSummaryOpen(false); }}>需求基本符合</Button>}</div></Modal>}
  </main>;
}

export function Message({ message }) {
  const user = message.role === 'user';
  return <article className={`message ${user ? 'message-user' : 'message-assistant'}`}>{!user && <span className="small-avatar"><Sparkles size={15} /></span>}<div className="message-main"><div className="message-content">{message.content}{message.attachments?.length > 0 && <div className="message-files">{message.attachments.map(a => <Attachment key={a.id} attachment={a} />)}</div>}</div><time className="message-time">{formatDate(message.createdAt)}</time></div></article>;
}

export function Profile({ profile = {} }) {
  const fields = [['项目', profile.project], ['业务场景', profile.scenario], ['要解决的问题', profile.problem], ['功能清单', profile.features?.join('、')], ['输入资料', profile.inputs], ['期望输出', profile.outputs], ['系统对接', profile.integrations], ...(profile.budget ? [['预算意向（自愿提供）', profile.budget]] : []), ['期望时间', profile.timeline]];
  return <dl className="profile-list">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={!value ? 'muted' : ''}>{value || '待进一步了解'}</dd></div>)}</dl>;
}

function QuoteCard({ conversation, busy, onFeedback }) {
  const quote = conversation.quote;
  return <section className="quote-card"><div className="quote-eyebrow"><span>项目参考区间</span><span>待人工确认</span></div><p className="quote-number"><small>¥</small>{formatMoney(quote.min)}<span>—</span>{formatMoney(quote.max)}</p><p className="quote-description">{quote.note || '基于可用于对外报价的同类项目资料，仅供当前需求范围参考。'}</p><p className="quote-caveat">云服务器、模型调用及维护等费用，由顾问另行确认。</p><div className="quote-feedback"><span>这个区间符合你的预期吗？</span><div>{['accepted', 'too_high', 'considering'].map(feedback => <Button key={feedback} variant={conversation.feedback === feedback ? 'primary' : 'secondary'} disabled={!!busy} loading={busy === 'feedback' && conversation.feedback === feedback} onClick={() => onFeedback(feedback)} aria-pressed={conversation.feedback === feedback}>{conversation.feedback === feedback && <Check size={14} />}{feedback === 'accepted' ? '基本符合' : feedback === 'too_high' ? '有些偏高' : '再考虑一下'}</Button>)}</div></div></section>;
}

function HandoffModal({ config, conversation, onClose, onSaved, requestBusy, beginOperation, endOperation }) {
  const [form, setForm] = useState({ phone: '', wechat: '', email: '', name: '', company: '', project: conversation?.profile?.project || conversation?.profile?.problem || conversation?.messages?.filter(message => message.role === 'user').at(-1)?.content?.slice(0, 1000) || '', consent: false });
  const [method, setMethod] = useState('wechat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(conversation?.contactSubmitted ? '此前已收到你的项目信息，可以扫码继续沟通。' : '');
  const [withdrawn, setWithdrawn] = useState(false);
  const [more, setMore] = useState(false);
  const saving = useRef(false);
  const update = (name, value) => setForm(old => ({ ...old, [name]: value }));
  const close = () => { if (!saving.current) onClose(); };
  async function withdraw() {
    const token = beginOperation('contact');
    if (!token) return;
    saving.current = true;
    setBusy(true); setError('');
    try { const result = await post(`/api/conversations/${conversation.id}/contact`, { consent: false }); setSaved(result.message || '已记录你的意愿，后续不再安排主动联系。'); setWithdrawn(true); onSaved(result); }
    catch (err) { setError(err.message); }
    finally { saving.current = false; setBusy(false); endOperation(token); }
  }
  async function submit(event) {
    event.preventDefault(); setError('');
    if (![form.phone, form.wechat, form.email].some(value => value.trim())) return setError('手机号、微信号或邮箱，填写一种就可以啦。');
    if (!form.project.trim()) return setError('请简单描述一下你想做的项目。');
    if (!form.consent) return setError('请确认同意我们使用这些信息联系你。');
    const token = beginOperation('contact');
    if (!token) return;
    saving.current = true;
    setBusy(true);
    try { const result = await post(`/api/conversations/${conversation.id}/contact`, form); setSaved(result.message || '你的项目信息已登记。'); onSaved(result); }
    catch (err) { setError(err.message); }
    finally { saving.current = false; setBusy(false); endOperation(token); }
  }
  return <Modal title="接下来，让顾问陪你细聊" subtitle="扫码添加企业微信，或留下方便联系你的方式。" onClose={close} wide><div className="handoff-grid"><aside className="qr-panel">{config?.qrUrl ? <img src={config.qrUrl} alt="人工客服企业微信二维码" className="qr-image" /> : <div className="qr-placeholder"><Headphones size={34} /><span>人工二维码待配置</span><small>你仍然可以在这里留言</small></div>}<strong>企业微信 · 人工顾问</strong><p>{config?.service?.message || '已登记的项目将由同事安排跟进。'}</p>{config?.service?.label && <span className="service-hours"><Clock3 size={14} />{config.service.label}</span>}</aside><form className="contact-form" onSubmit={submit}>{saved ? <div className="contact-saved"><span><Check size={24} /></span><h3>{withdrawn ? '已停止主动联系' : '收到你的项目信息啦'}</h3><p>{saved}</p><p className="muted small">{withdrawn ? '你仍然可以自行扫码联系顾问；已发送的群通知不会自动撤回。' : '这代表完成登记，实际回复以顾问联系为准。'}</p><Notice tone="danger">{error}</Notice><Button variant="secondary" onClick={close} disabled={busy} type="button">返回聊天</Button>{!withdrawn && <button className="text-button withdraw-contact" disabled={busy || requestBusy} type="button" onClick={withdraw}>{busy ? '正在处理…' : '停止联系我'}</button>}</div> : <><Field label="你的项目" required><textarea value={form.project} onChange={e => update('project', e.target.value)} maxLength={1000} minLength={4} rows={3} placeholder="例如：为销售团队搭建客户跟进 Agent" required /></Field><div className="field"><span className="field-label">方便联系你的方式 <span className="required">*</span></span><div className="contact-tabs" role="group" aria-label="选择联系方式">{[['wechat', '微信号'], ['phone', '手机号'], ['email', '邮箱']].map(([key, label]) => <button type="button" key={key} onClick={() => setMethod(key)} className={method === key ? 'selected' : ''} aria-pressed={method === key}>{label}</button>)}</div><input aria-label={method === 'wechat' ? '微信号' : method === 'phone' ? '手机号' : '邮箱'} type={method === 'email' ? 'email' : 'text'} inputMode={method === 'phone' ? 'tel' : undefined} value={form[method]} onChange={e => update(method, e.target.value)} autoComplete={method === 'phone' ? 'tel' : method === 'email' ? 'email' : 'off'} placeholder={method === 'wechat' ? '填写你的微信号' : method === 'phone' ? '填写你的手机号' : '填写你的邮箱地址'} maxLength={method === 'email' ? 254 : method === 'phone' ? 32 : 64} /><span className="field-hint">任选一种即可，切换选项不会清空已填内容。</span></div><button type="button" className="text-button" onClick={() => setMore(!more)}>{more ? '收起' : '补充'}称呼与公司名（选填）{more ? <ArrowUp size={14} /> : <ArrowDown size={14} />}</button>{more && <div className="form-grid"><Field label="怎么称呼你"><input value={form.name} onChange={e => update('name', e.target.value)} maxLength={80} autoComplete="name" /></Field><Field label="公司名称"><input value={form.company} onChange={e => update('company', e.target.value)} maxLength={160} autoComplete="organization" /></Field></div>}<label className="checkbox-row"><input type="checkbox" checked={form.consent} onChange={e => update('consent', e.target.checked)} /><span>我同意将项目及联系信息用于本次项目跟进，并通知公司内部业务群。系统保存 30 天，群内通知不自动撤回。</span></label><Notice tone="danger">{error}</Notice><Button loading={busy} disabled={requestBusy} type="submit" className="full-width"><Send size={16} />提交项目，等顾问联系</Button></>}</form></div></Modal>;
}
