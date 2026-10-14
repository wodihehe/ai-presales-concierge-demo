import path from 'node:path';
import {openStore} from './store.js';
import {createApp} from './app.js';

const store=openStore(path.resolve(process.env.DATA_DIR||'data'),{recoverNotificationHolds:true});
store.cleanup();const {app,tick}=createApp(store);
const port=Number(process.env.PORT||3218),host=process.env.HOST||'127.0.0.1';
const server=app.listen(port,host,()=>console.log(`客服系统已启动：http://${host}:${port}（外部配置状态请在后台查看）`));
const notificationTimer=setInterval(()=>tick().catch(()=>console.error('通知任务暂时失败，下次继续重试。')),5000);
const cleanupTimer=setInterval(()=>{try{store.cleanup();}catch{console.error('保留期清理失败，请检查存储权限。');}},60000);
notificationTimer.unref();cleanupTimer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(notificationTimer);clearInterval(cleanupTimer);server.close(()=>{store.close();process.exit(0);});});
