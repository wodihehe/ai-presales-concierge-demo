import React,{useEffect,useState} from 'react';
import {getLocale} from '../../shared/browser-locale.js';
import {t} from '../../shared/i18n.js';
const samples={
  商品图:'项目：商品图与文案生成助手\n场景：电商商品运营\n功能：生成商品主图；生成详情长图；生成商品文案\n输入：商品照片和参数\n输出：商品主图、详情长图和文案\n对接：不自动发布',
  内网问答:'项目：企业内网大模型知识问答\n场景：企业内网知识问答\n功能：本地模型部署；知识问答；权限控制\n输入：内部文档\n输出：带来源的问答\n对接：不对接其他系统',
  新类型:'项目：海洋浮标设备管理\n场景：海洋浮标监测\n功能：浮标定位；海水温度监测\n输入：浮标传感器数据\n输出：浮标位置与温度地图\n对接：浮标物联网接口'
};
export function DemoBar(){
  const [status,setStatus]=useState(null);
  const [locale,setLocale]=useState(getLocale);
  useEffect(()=>{const listener=()=>setLocale(getLocale());window.addEventListener('demo-locale-change',listener);return ()=>window.removeEventListener('demo-locale-change',listener);},[]);
  useEffect(()=>{fetch('/demo/status').then(r=>r.json()).then(setStatus).catch(()=>{});},[]);
  const sample=value=>locale==='zh'?value:value.split('\n').map(line=>{const [key,...rest]=line.split('：');const labels={项目:'Project',场景:'Scenario',功能:'Features',输入:'Inputs',输出:'Outputs',对接:'Integrations'};return `${labels[key]}: ${rest.join('：').split('；').map(v=>t(v,'en')).join('; ')}`;}).join('\n');
  return <aside className="demo-bar" aria-label="演示环境说明"><div><strong>DEMO · {status?.mode==='live'?'已配置真实模型':'离线流程模拟'}</strong><span>案例和价格均为虚构，通知仅存本机。</span><div className="language-switch" aria-label="Language"><button type="button" data-locale-button="zh" aria-pressed={locale==='zh'}>中文</button><button type="button" data-locale-button="en" aria-pressed={locale==='en'}>English</button></div><nav><a href={`/demo/login?lang=${locale}`}>演示后台</a><a href={`http://127.0.0.1:${status?.kbPort||3320}/demo/login?lang=${locale}`} target="_blank" rel="noreferrer">知识库工作台</a><a href={`/demo/login?inbox=1&lang=${locale}`} target="_blank" rel="noreferrer">演示收件箱</a></nav></div>{!location.pathname.startsWith('/admin')&&<div className="demo-examples"><span>填入示例后发送：</span>{Object.entries(samples).map(([label,value])=><button key={label} onClick={()=>window.dispatchEvent(new CustomEvent('demo-compose',{detail:sample(value)}))}>{label}</button>)}<small>留资示例：visitor@example.test（请使用虚构信息）</small></div>}</aside>;
}
