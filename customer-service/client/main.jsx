import React from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from './Chat';
import { Admin } from './Admin';
import './styles.css';
import { DemoBar } from './DemoBar';
import { installLocaleUI } from '../../shared/browser-locale.js';
installLocaleUI();

class AppErrorBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <main className="fatal-error"><h1>页面暂时遇到问题</h1><p>请重新加载后继续。已发送的咨询仍由服务端保存。</p><button className="button primary" onClick={() => location.reload()}>重新加载</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')).render(<AppErrorBoundary><DemoBar />{location.pathname.startsWith('/admin') ? <Admin /> : <Chat />}</AppErrorBoundary>);
