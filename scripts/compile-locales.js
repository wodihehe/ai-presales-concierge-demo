import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {root} from './paths.js';
const values={};
for(const line of readFileSync(path.join(root,'shared/en.txt'),'utf8').split(/\r?\n/)){
  const index=line.indexOf('\t');if(index>0)values[line.slice(0,index).replace(/\\n/g,'\n')]=line.slice(index+1).replace(/\\n/g,'\n');
}
writeFileSync(path.join(root,'shared/en.json'),JSON.stringify(values,null,2)+'\n');
console.log(`${Object.keys(values).length} English translations compiled.`);
