import React, { useEffect, useRef } from 'react';
import { ArrowUpRight, Check, CircleAlert, FileText, LoaderCircle, MessagesSquare, X } from 'lucide-react';
import { formatBytes } from './api';

export function Brand({ name = 'AI 业务顾问', compact = false }) {
  return <a className="brand" href="/" aria-label={`${name} 首页`}><span className="brand-symbol"><MessagesSquare size={23} strokeWidth={1.7} /><i /></span><span className="brand-text"><strong>{name}</strong>{!compact && <small>把想法，聊成可落地的方案</small>}</span></a>;
}
export function Button({ children, loading, variant = 'primary', className = '', ...props }) {
  return <button className={`button ${variant} ${className}`} {...props} disabled={props.disabled || loading}>{loading && <LoaderCircle className="spin" size={17} />}{children}</button>;
}
export function Notice({ children, tone = 'warning', onClose }) {
  if (!children) return null;
  return <div className={`notice ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><span>{tone === 'success' ? <Check size={17} /> : <CircleAlert size={17} />}</span><div>{children}</div>{onClose && <button className="icon-button notice-close" onClick={onClose} aria-label="关闭提示"><X size={17} /></button>}</div>;
}
export function Field({ label, hint, children, className = '', required = false }) {
  return <label className={`field ${className}`}><span className="field-label">{label}{required && <span className="required"> *</span>}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
export function Modal({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(null);
  const closer = useRef(onClose); closer.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const box = ref.current;
    box?.focus();
    const key = event => {
      if (event.key === 'Escape') closer.current?.();
      if (event.key === 'Tab') {
        const nodes = [...box.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(n => n.getClientRects().length);
        const first = nodes[0], last = nodes.at(-1);
        if (!nodes.length) return event.preventDefault();
        if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = bodyOverflow; document.removeEventListener('keydown', key); prev?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}><section className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-heading"><div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭窗口"><X size={21} /></button></div>{children}</section></div>;
}
export function EmptyState({ icon: Icon = MessagesSquare, title, children, action }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={27} strokeWidth={1.5} /></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function Loading({ label = '正在加载…' }) { return <div className="loading-state" role="status"><LoaderCircle className="spin" size={24} /><span>{label}</span></div>; }
export function Attachment({ attachment, onRemove }) {
  return <div className={`attachment ${attachment.status === 'unreadable' ? 'attachment-warning' : ''}`}><FileText size={20} /><div><strong>{attachment.name}</strong><small>{formatBytes(attachment.size || 0)}{attachment.status === 'unreadable' ? ' · 暂无法理解' : attachment.status === 'image_ready' ? ' · 待模型理解' : ' · 已提取文字'}</small>{attachment.note && <span className="attachment-note">{attachment.note}</span>}</div>{onRemove ? <button className="icon-button" onClick={onRemove} aria-label={`移除 ${attachment.name}`}><X size={16} /></button> : attachment.url && <a className="icon-button" href={attachment.url} target="_blank" rel="noreferrer" aria-label={`查看 ${attachment.name}`}><ArrowUpRight size={17} /></a>}</div>;
}
