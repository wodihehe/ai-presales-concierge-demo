import {installLocaleUI,getLocale} from './browser-locale.js';
installLocaleUI();
window.addEventListener('demo-locale-change',()=>{
  // Form values and original files are user data and are never rewritten by a language toggle.
  // Re-render only the visible static/dynamic labels in the locale observer.
  document.documentElement.lang=getLocale()==='en'?'en':'zh-CN';
  if(typeof window.loadProjects==='function'&&document.getElementById('viewProjects')?.style.display!=='none')window.loadProjects();
});
